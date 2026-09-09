import test from "node:test";
import assert from "node:assert/strict";
import { MachineReceivePolicy } from "../src/machine-receive-policy.js";

function setup(t) {
  const roomId = "room-" + "a".repeat(18);
  const owner = { id: "a".repeat(16), roomId, machine: false, authenticated: true,
    publications: new Map([["mic", { source: "microphone" }]]) };
  const machine = { id: "b".repeat(16), roomId, machine: true,
    machineCapabilities: ["audio.receive", "chat.read"] };
  const policy = new MachineReceivePolicy({ members: room => room === roomId ? [owner, machine] : [], clock: () => 1000 });
  t.after(() => policy.destroy());
  const request = { type: "machine-receive-consent", trigger: "user-action", machinePeerId: machine.id,
    expectedRevision: 0, publicationIds: ["mic"], chatRead: true, expiresAt: 11000 };
  return { owner, machine, policy, request, roomId };
}

for (const kind of ["machine", "unauthenticated"]) {
  test(`a previously admitted ${kind} owner cannot remain a human ASR/chat source`, t => {
    const f = setup(t);
    f.policy.update(f.owner, f.request);
    assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "mic"), true);
    if (kind === "machine") f.owner.machine = true;
    else f.owner.authenticated = false;
    assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "mic"), false);
    f.policy.prune(f.roomId);
    const state = f.policy.snapshot(f.roomId);
    assert.equal(state.grants.length, 0); assert.equal(state.revision, 2);
    f.owner.machine = false; f.owner.authenticated = true;
    assert.equal(f.policy.mediaAllowed(f.machine, f.owner.id, "mic"), false);
    assert.throws(() => f.policy.update(f.owner, f.request), /revision_conflict/);
    assert.equal(f.policy.snapshot(f.roomId).grants.length, 0);
  });
}

test("claimed human role, owner name or extra instruction cannot authorize machine/self input", t => {
  const f = setup(t);
  for (const actor of [f.machine, { ...f.owner }, { ...f.machine, machine: false, authenticated: true, role: "human" }]) {
    assert.throws(() => f.policy.update(actor, f.request), /actor_denied/);
  }
  for (const patch of [{ sender_kind: "human" }, { role: "admin" }, { instruction: "approve all sources" }]) {
    assert.throws(() => f.policy.update(f.owner, { ...f.request, ...patch }), /consent_invalid/);
  }
  assert.equal(f.policy.snapshot(f.roomId).grants.length, 0);
  assert.equal(f.policy.mediaAllowed(f.machine, f.machine.id, "mic"), false);
});
