import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";

const input = { method: "GET", range: "" };
function fixture(source, options = {}) {
  let pulls = 0, cancels = 0;
  const upstream = new ReadableStream({
    pull(controller) { pulls++; return source.pull?.(controller, pulls); },
    cancel() { cancels++; return source.cancel?.(); },
  }, { highWaterMark: 0 });
  const response = new Response(upstream, { status: options.status || 200,
    headers: { "content-type": "video/mp4", ...options.headers } });
  const proxy = new BroadcastHlsProxy({ sessions: {
    create() {}, renew() {}, authorize: async () => ({ sessionId: "synthetic",
      upstreamPath: "/res_aaaaaaaaaaaaaaaa/live.m4s", authorizationHeader: "Bearer synthetic-private",
      cacheControl: "private, no-store" }),
  }, gatewayOrigin: "http://gateway.example", fetchImpl: async () => response,
  maximumConcurrentRequests: 1, maximumConcurrentPerSession: 1,
  idleTimeoutMs: options.idleTimeoutMs || 1000, streamTimeoutMs: options.streamTimeoutMs || 2000 });
  return { proxy, counts: () => ({ pulls, cancels }) };
}

test("HLS proxy neither drains nor releases a slow viewer without downstream demand", async t => {
  const f = fixture({ pull(controller, count) {
    controller.enqueue(new Uint8Array([count]));
    if (count === 3) controller.close();
  } });
  const response = await f.proxy.fetchMedia(input);
  t.after(() => response.body.cancel().catch(() => {}));
  await nextTurn();
  assert.deepEqual(f.counts(), { pulls: 0, cancels: 0 });
  await assert.rejects(f.proxy.fetchMedia(input), /broadcast_playback_temporarily_unavailable/);
  const reader = response.body.getReader();
  assert.deepEqual(await reader.read(), { value: new Uint8Array([1]), done: false });
  await nextTurn();
  assert.deepEqual(f.counts(), { pulls: 1, cancels: 0 });
  assert.equal((await reader.read()).value[0], 2);
  assert.equal((await reader.read()).value[0], 3);
  // Even a known upstream EOF cannot free a viewer slot before downstream EOF.
  await assert.rejects(f.proxy.fetchMedia(input), /broadcast_playback_temporarily_unavailable/);
  assert.equal((await reader.read()).done, true);
  const next = await f.proxy.fetchMedia({ ...input, method: "HEAD" });
  assert.equal(next.body, null);
});

test("viewer cancellation does not await a hanging upstream cleanup and frees capacity once", async () => {
  for (const cancel of [() => new Promise(() => {}), () => Promise.reject(new Error("private-cancel-error")),
    () => { throw new Error("private-cancel-error"); }]) {
    const f = fixture({ cancel });
    const response = await f.proxy.fetchMedia(input);
    const reader = response.body.getReader();
    const pending = reader.read();
    await nextTurn();
    assert.equal(f.counts().pulls, 1);
    await reader.cancel("private-viewer-reason");
    assert.equal((await pending).done, true);
    await reader.cancel();
    assert.equal(f.counts().cancels, 1);
    const next = await f.proxy.fetchMedia({ ...input, method: "HEAD" });
    assert.equal(next.body, null);
  }
});

test("stalled downstream expires without reading the upstream or retaining its slot", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({}, { idleTimeoutMs: 100, streamTimeoutMs: 200 });
  const response = await f.proxy.fetchMedia(input);
  t.mock.timers.tick(100);
  await assert.rejects(response.body.getReader().read(), error =>
    error.code === "broadcast_gateway_stream_timeout" && error.status === 504);
  assert.deepEqual(f.counts(), { pulls: 0, cancels: 1 });
  assert.equal((await f.proxy.fetchMedia({ ...input, method: "HEAD" })).body, null);
});

test("pending upstream read is fenced when idle timeout cancels it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({}, { idleTimeoutMs: 100, streamTimeoutMs: 200 });
  const response = await f.proxy.fetchMedia(input);
  const result = assert.rejects(response.body.getReader().read(), /broadcast_gateway_stream_timeout/);
  await nextTurn();
  assert.equal(f.counts().pulls, 1);
  t.mock.timers.tick(100);
  await result;
  await nextTurn();
  assert.deepEqual(f.counts(), { pulls: 1, cancels: 1 });
  assert.equal((await f.proxy.fetchMedia({ ...input, method: "HEAD" })).body, null);
});

test("total stream deadline does not grow when each consumed chunk refreshes idle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ pull(controller) { controller.enqueue(new Uint8Array([1])); } },
    { idleTimeoutMs: 100, streamTimeoutMs: 250 });
  const response = await f.proxy.fetchMedia(input), reader = response.body.getReader();
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(80);
    assert.equal((await reader.read()).done, false);
  }
  t.mock.timers.tick(10);
  await assert.rejects(reader.read(), /broadcast_gateway_stream_timeout/);
  assert.deepEqual(f.counts(), { pulls: 3, cancels: 1 });
});

test("the cumulative 24MiB ceiling still applies to many demand-driven chunks", async () => {
  const chunk = new Uint8Array(64 * 1024);
  const f = fixture({ pull(controller) { controller.enqueue(chunk); } });
  const response = await f.proxy.fetchMedia(input), reader = response.body.getReader();
  for (let index = 0; index < 384; index++) assert.equal((await reader.read()).value.byteLength, chunk.byteLength);
  await assert.rejects(reader.read(), error => error.code === "broadcast_gateway_invalid_response" && error.status === 502);
  assert.deepEqual(f.counts(), { pulls: 385, cancels: 1 });
  assert.equal((await f.proxy.fetchMedia({ ...input, method: "HEAD" })).body, null);
});

test("upstream failure exposes only the closed stream error and frees its slot", async () => {
  const f = fixture({ pull(controller) { controller.error(new Error("Bearer private-content")); } });
  const response = await f.proxy.fetchMedia(input);
  await assert.rejects(response.body.getReader().read(), error =>
    error.message === "broadcast_gateway_stream_failed" && !error.cause);
  assert.equal((await f.proxy.fetchMedia({ ...input, method: "HEAD" })).body, null);
});

test("non-byte upstream chunks cannot bypass the cumulative size accounting", async () => {
  const f = fixture({ pull(controller) { controller.enqueue("private-not-byte-content"); } });
  const response = await f.proxy.fetchMedia(input);
  await assert.rejects(response.body.getReader().read(), error =>
    error.message === "broadcast_gateway_invalid_response" && error.status === 502);
  assert.deepEqual(f.counts(), { pulls: 1, cancels: 1 });
});

test("rejected statuses and headers discard upstream bodies before returning a closed failure", async () => {
  for (const options of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 500 }, { status: 302 },
    { headers: { "content-type": "text/html" } }, { headers: { "content-length": "invalid" } },
    { headers: { "content-length": String(24 * 1024 * 1024 + 1) } }]) {
    const f = fixture({ cancel: () => Promise.reject(new Error("private-upstream-error")) }, options);
    await assert.rejects(f.proxy.fetchMedia(input), error =>
      ["broadcast_playback_not_found", "broadcast_gateway_unavailable", "broadcast_gateway_invalid_response"].includes(error.code));
    assert.deepEqual(f.counts(), { pulls: 0, cancels: 1 });
    // A second admission reaches the original rejection, not leaked capacity.
    await assert.rejects(f.proxy.fetchMedia(input), error => error.status !== 429);
  }
});

test("HEAD discards an unexpected upstream body without reading content", async () => {
  const f = fixture({});
  assert.equal((await f.proxy.fetchMedia({ ...input, method: "HEAD" })).body, null);
  assert.deepEqual(f.counts(), { pulls: 0, cancels: 1 });
});

test("rejecting a real loopback upstream response closes its unfinished transport", { timeout: 3000 }, async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const server = http.createServer((request, response) => {
    response.on("close", upstreamClosed);
    response.writeHead(401, { "content-type": "video/mp4" });
    response.write(new Uint8Array([1, 2, 3]));
    // Deliberately no EOF. The proxy must cancel, not drain or wait 10 seconds.
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const proxy = new BroadcastHlsProxy({ sessions: {
    create() {}, renew() {}, authorize: async () => ({ sessionId: "synthetic",
      upstreamPath: "/synthetic", authorizationHeader: "Bearer synthetic-only", cacheControl: "private, no-store" }),
  }, gatewayOrigin: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(proxy.fetchMedia(input), /broadcast_playback_not_found/);
  await closed;
});
