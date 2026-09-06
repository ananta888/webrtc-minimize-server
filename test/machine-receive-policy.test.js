import assert from "node:assert/strict";
import test from "node:test";
import { MachineReceivePolicy, parseMachineReceiveConsent } from "../src/machine-receive-policy.js";
import { RoomRegistry } from "../src/room-registry.js";

function fixture() {
  let now = 1000;
  const roomId = "room-111111111111111111";
  const owner = { id: "aaaaaaaaaaaaaaaa", roomId, authenticated: true, machine: false,
    publications: new Map([["mic", { source: "microphone" }], ["camera", { source: "camera" }]]) };
  const machine = { id: "bbbbbbbbbbbbbbbb", roomId, machine: true, machineCapabilities: ["audio.receive", "chat.read"] };
  let members = [owner, machine]; const changes = [];
  const policy = new MachineReceivePolicy({ members: room => room === roomId ? members : [], clock: () => now,
    changed: (_, state) => changes.push(state) });
  const request = { type: "machine-receive-consent", trigger: "user-action", machinePeerId: machine.id,
    expectedRevision: 0, publicationIds: ["mic"], chatRead: true, expiresAt: 11_000 };
  return { policy, owner, machine, request, changes, advance: ms => { now += ms; }, leave: () => { members = [owner]; } };
}
test("publisher authorizes exact own audio and own chat with CAS revision", t => {
  const f = fixture(); t.after(() => f.policy.destroy());
  assert.equal(f.policy.snapshot(f.owner.roomId).grants.length, 0);
  assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "mic"), false);
  const state = f.policy.update(f.owner, f.request);
  assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "mic"), true);
  assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "camera"), false);
  assert.equal(f.policy.mediaAllowed({ ...f.machine }, f.owner.id, "mic"), false);
  assert.equal(state.revision, 1); assert.equal(state.grants[0].publisherPeerId, f.owner.id);
  assert.throws(() => f.policy.update(f.owner, f.request), /revision_conflict/);
  assert.equal(f.policy.update(f.owner, { ...f.request, expectedRevision: 1, publicationIds: [], chatRead: false }).grants.length, 0);
  assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "mic"), false);
});
test("Hub signature or creator role never grants another publisher's sources", t => {
  const f = fixture(); t.after(() => f.policy.destroy());
  for (const publicationIds of [["foreign-mic"], ["camera"]]) {
    assert.throws(() => f.policy.update(f.owner, { ...f.request, publicationIds }), /scope_denied/);
  }
  for (const actor of [{ ...f.owner, creator: true }, f.machine, { ...f.owner, authenticated: false }]) {
    assert.throws(() => f.policy.update(actor, f.request), /actor_denied/);
  }
  f.machine.machineCapabilities = [];
  assert.throws(() => f.policy.update(f.owner, f.request), /scope_denied/);
});
test("unknown contracts, excessive lifetime and duplicate source IDs are denied", t => {
  const f = fixture(); t.after(() => f.policy.destroy());
  for (const patch of [{ tools: true }, { trigger: "remote" }, { publicationIds: ["mic", "mic"] },
    { expectedRevision: true }, { chatRead: 1 }]) assert.throws(() => parseMachineReceiveConsent({ ...f.request, ...patch }));
  assert.throws(() => f.policy.update(f.owner, { ...f.request, expiresAt: 601_001 }), /scope_denied/);
});
test("expiry, membership departure and publication replacement revoke receipts", () => {
  for (const change of [f => f.advance(10_001), f => f.leave(), f => f.owner.publications.delete("mic")]) {
    const f = fixture(); f.policy.update(f.owner, f.request); change(f); f.policy.prune(f.owner.roomId);
    assert.equal(f.policy.snapshot(f.owner.roomId).grants.length, 0);
    assert.equal(f.changes.length, 2); f.policy.destroy();
  }
});

test("mixed-version rooms cannot leak to machines through unaware old clients", () => {
  const registry = new RoomRegistry(), room = "room-111111111111111111";
  const old = registry.join(room, {}, "old").peer;
  assert.throws(() => registry.join(room, {}, "machine", Date.now(), { machine: true, machineReceiveVersion: 1 }), /upgrade_required/);
  registry.leave(old);
  registry.join(room, {}, "machine", Date.now(), { machine: true, machineReceiveVersion: 1 });
  assert.throws(() => registry.join(room, {}, "old"), /upgrade_required/);
  assert.equal(registry.join(room, {}, "current", Date.now(), { machineReceiveVersion: 1 }).existingPeers[0].machine, true);
});
