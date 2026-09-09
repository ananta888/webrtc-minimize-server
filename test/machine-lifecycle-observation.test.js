import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { beforeMachineLeaseExpiry, retiredMachineAvatar } from "./helpers/machine-lifecycle-observation.mjs";

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
