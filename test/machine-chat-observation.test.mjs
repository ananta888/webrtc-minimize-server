import test from "node:test";
import assert from "node:assert/strict";
import { observeDialogAnswer } from "./helpers/machine-chat-observation.mjs";

const empty = { attempted: 0, queued: 0, send_failures: 0, answer_seen: false, rendered: false };
const timeout = () => Object.assign(new Error("private browser details"), { name: "TimeoutError" });
function page(value) {
  const calls = { wait: 0, read: 0 };
  return { calls,
    async waitForFunction(_fn, argument, options) {
      calls.wait++; assert.equal(argument, null); assert.deepEqual(options, { timeout: 30000 }); throw timeout();
    },
    async evaluate() { calls.read++; return value; },
  };
}

test("successful answer retains exact shape and uses no diagnostic read", async () => {
  const result = { correlated: true, text_sha256: "a".repeat(64) }, p = page(result);
  p.waitForFunction = async () => {};
  assert.equal(await observeDialogAnswer(p), result); assert.equal(p.calls.read, 1);
});

test("answer timeout remains failure with exactly one closed snapshot and no replay", async () => {
  const p = page(empty), result = await observeDialogAnswer(p);
  assert.deepEqual(result, { correlated: false, chat_probe: { available: true, ...empty } });
  assert.deepEqual(p.calls, { wait: 1, read: 1 }); assert.equal(JSON.stringify(result).includes("private"), false);
});

for (const value of [null, {}, { ...empty, secret: "private" }, { ...empty, attempted: "1" },
  { ...empty, attempted: 9 }, { ...empty, queued: 1 }, { ...empty, send_failures: -1 },
  { ...empty, rendered: true }, { ...empty, answer_seen: "private" }]) {
  test("malformed diagnostic fails closed without projecting arbitrary data: " + JSON.stringify(Object.keys(value || {})), async () => {
    assert.deepEqual(await observeDialogAnswer(page(value)), { correlated: false, chat_probe: { available: false } });
  });
}

test("failed and late diagnostic reads are bounded and never change a returned failure", async () => {
  let resolveRead, cleared = 0;
  const p = page(null);
  p.evaluate = () => new Promise(resolve => { resolveRead = resolve; });
  const timers = {
    setTimeout(callback, ms) { assert.equal(ms, 1000); queueMicrotask(callback); return 17; },
    clearTimeout(id) { assert.equal(id, 17); cleared++; },
  };
  const result = await observeDialogAnswer(p, timers);
  resolveRead({ ...empty, attempted: 1, queued: 1 }); await Promise.resolve();
  assert.deepEqual(result, { correlated: false, chat_probe: { available: false } }); assert.equal(cleared, 1);
  p.evaluate = async () => { throw new Error("private diagnostic exception"); };
  assert.deepEqual(await observeDialogAnswer(p), result);
});

test("non-timeout browser errors retain their original failure with no diagnostic IO", async () => {
  const p = page(empty), error = new Error("private different failure");
  p.waitForFunction = async () => { throw error; };
  await assert.rejects(observeDialogAnswer(p), caught => caught === error);
  assert.equal(p.calls.read, 0);
});
