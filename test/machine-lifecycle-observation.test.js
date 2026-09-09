import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { beforeMachineLeaseExpiry, retiredMachineAvatar, machineLeaseSupplyObservation } from "./helpers/machine-lifecycle-observation.mjs";

function fixture(fn) {
  let now = 1000;
  const state = { joined: true, e2ee: "active", peers: 3 };
  const source = { open: true }, avatar = { state: "open" }, window = { __leaseSource: { error: false }, anantaMachine: {
    status: () => state, screen: { status: () => source }, avatar: { status: () => avatar },
  } };
  return { run: vm.runInNewContext(`(${fn.toString()})`, { window, Date: { now: () => now } }),
    state, source, avatar, advance: value => { now = value; } };
}
test("expiry observation waits for the original window and freezes state before the controller reads it", () => {
  const f = fixture(beforeMachineLeaseExpiry);
  assert.equal(f.run(2000), false); f.advance(1300);
  const observed = f.run(2000); f.advance(2100); f.source.open = f.state.joined = false; f.state.e2ee = "disabled";
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), { joined: true, open: true, error: false, e2ee: "active", observedAt: 1300 });
  assert.equal(f.run(2000).observedAt, 2100, "late observation remains visibly late, never retrodated");
});
test("survivor requires its own membership departure and old avatar shutdown, never an explicit close or reopen", () => {
  const f = fixture(retiredMachineAvatar);
  assert.equal(f.run(2), false); f.state.peers = 2;
  assert.equal(f.run(2), false);
  for (const state of ["opening", "waiting", "unknown", undefined]) {
    f.avatar.state = state; assert.equal(f.run(2), false);
  }
  for (const state of ["closed", "failed"]) {
    f.avatar.state = state; assert.equal(f.run(2), true);
  }
  f.state.joined = false;
  assert.equal(f.run(2), false);
});

test("lease supplier diagnostics expose bounded relative timings and fixed reasons, never arbitrary source values", () => {
  const state = { sequence: 12, pushInFlight: false, lastPushDurationMs: 12.4, lastAccepted: 8300, closedAt: 10250,
    privateFrame: "must-not-appear" };
  let reason = "activation_expired";
  const run = vm.runInNewContext(`(${machineLeaseSupplyObservation.toString()})`, {
    window: { __leaseSource: state, anantaMachine: { screen: { diagnostics: () => ({ lastStopReason: reason }) } } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(run(10000))), { suppliedFrames: 12, pushInFlight: false,
    lastPushDurationMs: 12, lastAcceptedBeforeExpiryMs: 1700, rejectedAfterExpiryMs: 250, sourceStopReason: "activation_expired" });
  Object.assign(state, { sequence: 100000, pushInFlight: "private", lastPushDurationMs: Infinity, lastAccepted: 1, closedAt: 0 });
  reason = "private error or frame";
  assert.deepEqual(JSON.parse(JSON.stringify(run(100000))), { suppliedFrames: 80, pushInFlight: false,
    lastPushDurationMs: null, lastAcceptedBeforeExpiryMs: 45000, rejectedAfterExpiryMs: null, sourceStopReason: "unknown" });
});
