import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installMachineSourceFailureTrace } from "./helpers/machine-source-failure-trace.mjs";

function fixture() {
  let now = 100, wall = 1_000_000, step = 0;
  const realm = vm.createContext({ wallClock: () => wall,
    performance: { now: () => { const value = now; now += step; return value; } } });
  vm.runInContext("window = globalThis; originalError = Error", realm);
  vm.runInContext("Date.now = wallClock", realm);
  vm.runInContext(`(${installMachineSourceFailureTrace.toString()})()`, realm);
  return { realm, run: code => vm.runInContext(code, realm),
    advance: (ms, wallMs = ms) => { now += ms; wall += wallMs; },
    setWall: value => { wall = value; }, setReadStep: value => { step = value; } };
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
    events: [{ code: "meet_speech_closed", elapsedMs: 50, wallElapsedMs: 50, clockReadSpanMs: 0 }], truncated: false,
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

test("paired relative clocks expose a wall step without changing either application clock", () => {
  const f = fixture(); f.advance(790, 3000);
  f.run("new Error('meet_avatar_authority_expired', {cause:'controller-expired'})");
  assert.deepEqual(JSON.parse(f.run("JSON.stringify(__machineSourceFailureTrace.snapshot().events[0])")), {
    code: "meet_avatar_authority_expired", cause: "controller-expired", elapsedMs: 790,
    wallElapsedMs: 3000, clockReadSpanMs: 0,
  });
  assert.equal(f.run("Date.now === wallClock"), true);
  assert.equal(f.run("Date.now()"), 1_003_000);
});

test("backward and invalid clocks are bounded and never serialized as absolute timestamps", () => {
  const f = fixture(); f.advance(50, -100);
  f.run("new Error('meet_speech_closed')");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[0].wallElapsedMs"), -100);
  f.setWall(NaN); f.run("new Error('meet_speech_closed')");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[1].wallElapsedMs"), null);
  f.setWall(9_000_000); f.run("new Error('meet_speech_closed')");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[2].wallElapsedMs"), null);
});

test("reports the sampling span and preserves the original error if the diagnostic clock throws", () => {
  const f = fixture(); f.setReadStep(20); f.run("new Error('meet_speech_closed')");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[0].clockReadSpanMs"), 20);
  assert.equal(f.run("Date.now = () => { throw 'private clock detail'; }; new Error('meet_speech_closed').message"), "meet_speech_closed");
  assert.equal(f.run("__machineSourceFailureTrace.snapshot().events[1].wallElapsedMs"), null);
});
