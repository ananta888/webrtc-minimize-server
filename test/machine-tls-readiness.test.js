import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitMachineTlsReady } from "./helpers/machine-tls-readiness.mjs";

function fixture(action = () => {}) {
  let now = 0, next = 0;
  const timers = new Map(), requests = [], responses = [];
  const schedule = (fn, delay) => { timers.set(++next, { at: now + delay, fn }); return next; };
  const cancel = id => timers.delete(id);
  const get = (url, options, callback) => {
    const request = new EventEmitter(), socket = new EventEmitter();
    request.destroy = () => { request.destroyed = true; };
    request.respond = (statusCode = 200) => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => { response.destroyed = true; };
      responses.push(response); callback(response);
    };
    Object.assign(request, { socket, url, options }); requests.push(request);
    schedule(() => { request.emit("socket", socket); action(request, requests.length); }, 0);
    return request;
  };
  return {
    options: { get, clock: () => now, schedule, cancel }, timers, requests, responses,
    jump: value => { now = value; },
    async next() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(entry, "expected a bounded timer");
      timers.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    async settle(promise) {
      let settled = false, value, error;
      promise.then(result => { value = result; settled = true; }, failure => { error = failure; settled = true; });
      for (let i = 0; i < 400 && !settled; i++) await this.next();
      assert.ok(settled, "bounded operation settles");
      return { value, error };
    },
  };
}

const probe = f => waitMachineTlsReady("https://synthetic.invalid", Buffer.from("synthetic-ca"), f.options);

test("TLS readiness uses exact CA, no pooled socket and destroys successful response/request", async () => {
  const f = fixture(request => { request.socket.emit("connect"); request.socket.emit("secureConnect"); request.respond(); });
  const { value, error } = await f.settle(probe(f));
  assert.equal(error, undefined);
  assert.deepEqual(value, { phase: "http", reason: "ready", attempts: 1 });
  assert.equal(f.requests[0].url, "https://synthetic.invalid/healthz");
  assert.deepEqual(f.requests[0].options, { ca: Buffer.from("synthetic-ca"), agent: false, rejectUnauthorized: true });
  assert.equal(f.requests[0].destroyed, true); assert.equal(f.responses[0].destroyed, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests[0].socket.listenerCount("connect"), 0);
  assert.equal(f.requests[0].socket.listenerCount("secureConnect"), 0);
});

test("a request that never emits timeout/error is bounded by five seconds and cleaned up", async () => {
  const f = fixture();
  const { error } = await f.settle(probe(f));
  assert.equal(error.message, "test_tls_proxy_not_ready");
  assert.deepEqual(error.tlsReadiness, { phase: "connect", reason: "timeout", attempts: 15 });
  assert.equal(f.options.clock(), 5000);
  assert.equal(f.timers.size, 0);
  assert.ok(f.requests.every(request => request.destroyed));
});

test("late 200 cannot win after a total deadline even before timer delivery", async () => {
  const f = fixture(request => { f.jump(5000); request.respond(); });
  const { error } = await f.settle(probe(f));
  assert.deepEqual(error.tlsReadiness, { phase: "http", reason: "timeout", attempts: 1 });
  assert.equal(f.timers.size, 0);
});

test("late 200 cannot win the per-attempt deadline, and old callbacks cannot settle a successor", async () => {
  const f = fixture((request, attempt) => {
    if (attempt === 1) { f.jump(301); request.respond(); }
    else { f.requests[0].respond(); request.respond(); }
  });
  const { value } = await f.settle(probe(f));
  assert.equal(value.attempts, 2);
  assert.ok(f.responses.every(response => response.destroyed));
  assert.ok(f.requests.every(request => request.destroyed));
});

for (const [code, reason] of [["ECONNREFUSED", "refused"], ["ECONNRESET", "reset"], ["SECRET_CANARY", "transport"]]) {
  test(`readiness keeps bounded, content-free ${reason} diagnostics`, async () => {
    const f = fixture(request => request.emit("error", { code, message: "secret-canary https://secret.invalid" }));
    const { error } = await f.settle(probe(f));
    assert.equal(error.tlsReadiness.reason, reason);
    assert.equal(error.tlsReadiness.attempts, 100);
    assert.equal(f.options.clock(), 5000);
    assert.doesNotMatch(JSON.stringify(error), /secret|CANARY|https/);
    assert.equal(f.timers.size, 0);
  });
}

test("certificate rejection fails immediately without disabling TLS or retrying", async () => {
  const f = fixture(request => { request.socket.emit("connect"); request.emit("error", { code: "ERR_TLS_CERT_ALTNAME_INVALID" }); });
  const { error } = await f.settle(probe(f));
  assert.deepEqual(error.tlsReadiness, { phase: "tls", reason: "certificate", attempts: 1 });
  assert.equal(f.timers.size, 0); assert.equal(f.requests[0].destroyed, true);
});

test("non-200 and redirects never count as ready; only original health URL is requested", async () => {
  const f = fixture((request, attempt) => request.respond(attempt === 1 ? 302 : 503));
  const { error } = await f.settle(probe(f));
  assert.equal(error.tlsReadiness.reason, "http-status");
  assert.equal(f.options.clock(), 5000);
  assert.ok(f.requests.every(request => request.url === "https://synthetic.invalid/healthz" && request.destroyed));
});

test("TLS progress cannot keep a hanging HTTP request alive indefinitely", async () => {
  const f = fixture(request => { request.socket.emit("connect"); request.socket.emit("secureConnect"); });
  const { error } = await f.settle(probe(f));
  assert.deepEqual(error.tlsReadiness, { phase: "http", reason: "timeout", attempts: 15 });
  assert.equal(f.options.clock(), 5000); assert.equal(f.timers.size, 0);
});
