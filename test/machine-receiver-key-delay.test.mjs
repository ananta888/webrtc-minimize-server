import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { installReceiverKeyDelay, requireReceiverKeyDelay } from "./helpers/machine-receiver-key-delay.mjs";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

function fixture() {
  const sent = [], timers = new Map();
  let next = 0, now = 100, terminated = 0;
  const sandbox = { ArrayBuffer, Uint8Array, performance: { now: () => now },
    setTimeout(fn, delay) { assert.equal(delay, 2000); timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
    window: { Worker: class {
      postMessage(...args) { sent.push(args); }
      terminate() { terminated++; }
    } },
  };
  vm.runInNewContext(`(${installReceiverKeyDelay.toString()})()`, sandbox);
  return { sent, timers, sandbox, advance: () => { now += 2000; }, terminated: () => terminated,
    worker: () => new sandbox.window.Worker("synthetic", { name: "sframe-media" }) };
}
const key = () => ({ type: "set-key", direction: "decrypt", contextId: "synthetic", keyId: "0000000000000001",
  baseKey: new Uint8Array(16).fill(42).buffer });

test("delays only one receiver key without changing key bytes, ACKs or transfer ownership", () => {
  const f = fixture(), worker = f.worker(), held = key();
  worker.postMessage({ ...key(), direction: "encrypt" }); assert.equal(f.sent.length, 1);
  worker.postMessage(held, [held.baseKey]); assert.equal(f.sent.length, 1);
  const duplicate = key(); worker.postMessage(duplicate);
  assert.equal(f.sent.length, 1); assert.deepEqual([...new Uint8Array(duplicate.baseKey)], Array(16).fill(0));
  worker.postMessage(held); assert.deepEqual([...new Uint8Array(held.baseKey)], Array(16).fill(42));
  f.advance(); f.timers.get(1)();
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1][0], held); assert.equal(f.sent[1][1][0], held.baseKey);
  assert.deepEqual([...new Uint8Array(held.baseKey)], Array(16).fill(42));
  assert.equal(requireReceiverKeyDelay(f.sandbox.window.__receiverKeyDelay).delayMs, 2000);
  worker.postMessage(key()); assert.equal(f.sent.length, 3);
});

for (const reason of ["terminate", "all", "context", "replacement"]) {
  test(`wipes and cancels only its pending key on ${reason}; late callback cannot revive it`, () => {
    const f = fixture(), worker = f.worker(), held = key();
    worker.postMessage(held); const late = f.timers.get(1);
    if (reason === "terminate") worker.terminate();
    else worker.postMessage(reason === "all" ? { type: "clear-all" }
      : reason === "context" ? { type: "clear-context", contextId: "synthetic" }
        : { ...key(), keyId: "0000000000000002" });
    const sent = f.sent.length; late(); assert.equal(f.sent.length, sent);
    assert.equal(f.timers.size, reason === "replacement" ? 1 : 0);
    assert.deepEqual([...new Uint8Array(held.baseKey)], Array(16).fill(0));
    assert.equal(f.sandbox.window.__receiverKeyDelay.cancelled, 1);
    assert.throws(() => requireReceiverKeyDelay(f.sandbox.window.__receiverKeyDelay), /not_observed/);
  });
}

test("unknown options fail before provisioning and snapshots remain closed", async () => {
  const after = () => assert.fail("must not provision");
  for (const value of ["1", 1, null, {}]) {
    await assert.rejects(machineBrowserFixture({ after }, { receiverKeyDelay: value }), /delay_invalid/);
  }
  for (const value of [null, {}, { scheduled: 1, delivered: 1, cancelled: 0, delayMs: 1999 },
    { scheduled: 1, delivered: 1, cancelled: 0, delayMs: 2000, key: "never-report" }]) {
    assert.throws(() => requireReceiverKeyDelay(value), /not_observed/);
  }
});

test("current replacement keys have at most three delays and no stale callbacks", () => {
  const f = fixture(), worker = f.worker();
  const callbacks = [];
  for (let id = 1; id <= 4; id++) {
    worker.postMessage({ ...key(), keyId: String(id).padStart(16, "0") });
    if (id <= 3) callbacks.push(f.timers.get(id));
  }
  assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1);
  callbacks.forEach(fn => fn()); assert.equal(f.sent.length, 1);
  assert.equal(f.sandbox.window.__receiverKeyDelay.scheduled, 3);
  assert.equal(f.sandbox.window.__receiverKeyDelay.cancelled, 3);
  assert.throws(() => requireReceiverKeyDelay(f.sandbox.window.__receiverKeyDelay), /not_observed/);
});
