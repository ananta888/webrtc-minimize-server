import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installMachineSourceFailureTrace } from "./helpers/machine-source-failure-trace.mjs";

function fixture() {
  let now = 100;
  const realm = vm.createContext({ performance: { now: () => now } });
  vm.runInContext("window = globalThis; originalError = Error", realm);
  vm.runInContext(`(${installMachineSourceFailureTrace.toString()})()`, realm);
  return { realm, run: code => vm.runInContext(code, realm), advance: ms => { now += ms; } };
}

test("private failure trace preserves native error construction, subclassing, cause and thrown identity", () => {
  const f = fixture();
  assert.equal(f.run("Error.prototype === originalError.prototype"), true);
  assert.equal(f.run("const cause = {}; const err = new Error('meet_avatar_authority_expired', {cause}); err.cause === cause && err instanceof Error && err instanceof originalError"), true);
  assert.equal(f.run("try { throw err; } catch (caught) { caught === err && caught.message === 'meet_avatar_authority_expired'; }"), true);
  assert.equal(f.run("class Derived extends Error {}; const sub = new Derived('meet_speech_closed'); sub instanceof Derived && sub instanceof originalError"), true);
  assert.equal(f.run("Error('meet_avatar_not_ready') instanceof originalError"), true);
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events.length"), 3);
  f.run("__machineSourceFailureTrace.close()"); assert.equal(f.run("Error === originalError"), true);
});

test("trace keeps only bounded recognized scalars, never raw errors, stacks, sources or cause objects", () => {
  const f = fixture(); f.advance(50);
  f.run("new Error('private source/token text'); new Error('meet_speech_closed: private'); new Error('meet_speech_closed', {cause: {secret: 'never retain'}})");
  assert.deepEqual(JSON.parse(f.run("JSON.stringify(__machineSourceFailureTrace.snapshot())")), {
    events: [{ code: "meet_speech_closed", elapsedMs: 50 }], truncated: false,
  });
  f.run("for(let i=0;i<100;i++) new Error('meet_speech_closed')");
  const projection = JSON.parse(f.run("JSON.stringify(__machineSourceFailureTrace.snapshot())"));
  assert.equal(projection.events.length, 64); assert.equal(projection.truncated, true);
  f.run("__machineSourceFailureTrace.snapshot().events[0].code='secret'");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[0].code"), "meet_speech_closed");
});

test("closed tracing neither records new failures nor overwrites a newer owner; elapsed time is bounded", () => {
  const f = fixture(); f.advance(-1); f.run("new Error('meet_speech_closed')");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[0].elapsedMs"), null);
  f.run("const other = function Other() {}; Error = other; __machineSourceFailureTrace.close()");
  assert.equal(f.run("Error === other"), true);
});

test("known cause projection does not evaluate ErrorOptions getters a second time", () => {
  const f = fixture();
  assert.equal(f.run("let reads=0; new Error('meet_avatar_authority_expired', {get cause(){reads++;return 'clock-backwards'}}); reads"), 1);
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[0].cause"), "clock-backwards");
});
