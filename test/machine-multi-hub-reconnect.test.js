import assert from "node:assert/strict";
import test from "node:test";
import { MultiHubReconnect } from "./helpers/machine-multi-hub-reconnect.mjs";

function fixture() {
  let interrupted = 0;
  const first = { id: "a", machine: true, principal: "synthetic-first", deviceFingerprint: "device-a", socket: { terminate() { ++interrupted; } } };
  const second = { id: "b", machine: true, principal: "synthetic-second", deviceFingerprint: "device-b" };
  const state = { members: [first, second, { id: "human", machine: false }] };
  const reconnect = new MultiHubReconnect({ members(room) { assert.equal(room, "synthetic-room"); return state.members; } }, "synthetic-room");
  return { reconnect, state, first, second, interrupted: () => interrupted };
}

test("only two distinct replacements and three exact-owned interruptions are possible", () => {
  const f = fixture(); let peers = ["a", "b"];
  for (const [index, id] of ["c", "d"].entries()) {
    assert.deepEqual(f.reconnect.interrupt(peers), { interrupted: 0, attempt: index + 1 });
    assert.throws(() => f.reconnect.interrupt(peers), /owner_invalid/);
    f.state.members[0] = { ...f.first, id };
    peers = f.reconnect.replace(peers);
    assert.deepEqual(peers, [id, "b"]);
  }
  f.reconnect.interrupt(peers);
  f.state.members[0] = { ...f.first, id: "e" };
  assert.throws(() => f.reconnect.replace(peers), /replacement_invalid/);
  assert.throws(() => f.reconnect.interrupt(peers), /owner_invalid/);
  assert.equal(f.interrupted(), 3);
});

for (const mutation of ["unknown", "human", "duplicate", "extra-member", "no-socket"]) {
  test(`invalid ${mutation} interruption cannot close another member`, () => {
    const f = fixture(), peers = ["a", "b"];
    if (mutation === "unknown") peers[0] = "foreign";
    if (mutation === "human") peers[0] = "human";
    if (mutation === "duplicate") peers[1] = "a";
    if (mutation === "extra-member") f.state.members.push({ id: "other" });
    if (mutation === "no-socket") delete f.first.socket;
    assert.throws(() => f.reconnect.interrupt(peers), /owner_invalid/);
    assert.equal(f.interrupted(), 0);
  });
}

for (const mutation of ["old-peer", "wrong-principal", "wrong-device", "survivor-lost", "duplicate-principal"]) {
  test(`invalid ${mutation} replacement cannot claim recovery`, () => {
    const f = fixture(), peers = ["a", "b"];
    f.reconnect.interrupt(peers);
    f.state.members[0] = { ...f.first, id: "c" };
    if (mutation === "old-peer") f.state.members[0].id = "a";
    if (mutation === "wrong-principal") f.state.members[0].principal = "foreign";
    if (mutation === "wrong-device") f.state.members[0].deviceFingerprint = "foreign";
    if (mutation === "survivor-lost") f.state.members[1].id = "foreign";
    if (mutation === "duplicate-principal") f.state.members[1].principal = f.first.principal;
    assert.throws(() => f.reconnect.replace(peers), /replacement_invalid/);
    assert.equal(f.interrupted(), 1);
  });
}
