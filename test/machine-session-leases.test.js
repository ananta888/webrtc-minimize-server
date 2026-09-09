import assert from "node:assert/strict";
import test from "node:test";
import { MachineSessionLeases } from "../src/machine-session-leases.js";

function fixture() {
  let now = 1000, member = true;
  const binding = { issuer: "https://hub.example", subject: "machine:ananta", roomId: "room-111111111111111111",
    taskId: "task", tenantId: "tenant", projectId: "project", protocolVersion: "v1", runtimeId: "", hubSessionId: "",
    capabilitySet: "avatar.publish,chat.send,speech.publish" };
  const identity = { machineBinding: binding, machineExpiresAt: now + 120_000 };
  const leases = new MachineSessionLeases({ clock: () => now });
  const first = leases.issue(identity, "device");
  let stopped = 0;
  leases.attach(first.sessionId, () => member, () => { stopped++; });
  return { leases, first, identity, stopped: () => stopped, advance: delta => { now += delta; }, leave: () => { member = false; } };
}
test("three fresh grants renew the same membership with monotone fencing", t => {
  const f = fixture(); t.after(() => f.leases.destroy());
  let lease = f.first;
  for (let i = 0; i < 3; i++) {
    f.advance(30_000);
    lease = f.leases.renew(lease.sessionId, lease.generation,
      { ...f.identity, machineExpiresAt: lease.expiresAt + 30_000 }, "device");
    assert.equal(lease.generation, i + 2); assert.equal(lease.sessionId, f.first.sessionId);
    assert.equal(lease.absoluteExpiresAt, f.first.absoluteExpiresAt);
  }
  assert.equal(f.stopped(), 0);
  assert.throws(() => f.leases.issue(f.identity, "device"), /already_active/);
});
test("renewal rejects foreign task, tenant, project, issuer, room, subject and device", t => {
  const f = fixture(); t.after(() => f.leases.destroy());
  for (const key of Object.keys(f.identity.machineBinding)) {
    assert.throws(() => f.leases.renew(f.first.sessionId, 1,
      { machineBinding: { ...f.identity.machineBinding, [key]: "other" }, machineExpiresAt: 200_000 }, "device"), /scope_invalid/);
  }
  assert.throws(() => f.leases.renew(f.first.sessionId, 1, { ...f.identity, machineExpiresAt: 200_000 }, "other"), /scope_invalid/);
});
test("only one concurrent generation wins; old ACK and non-extending grants fail closed", t => {
  const f = fixture(); t.after(() => f.leases.destroy());
  assert.throws(() => f.leases.renew(f.first.sessionId, 1, f.identity, "device"), /deadline_invalid/);
  const next = { ...f.identity, machineExpiresAt: 200_000 };
  f.leases.renew(f.first.sessionId, 1, next, "device");
  assert.throws(() => f.leases.renew(f.first.sessionId, 1, next, "device"), /generation_conflict/);
});
test("expiry, membership loss, close and clock rollback prevent revival", () => {
  for (const action of [f => f.advance(120_000), f => f.leave(), f => f.leases.close(f.first.sessionId), f => f.advance(-1)]) {
    const f = fixture(); action(f);
    assert.equal(f.leases.live(f.first.sessionId), false);
    assert.throws(() => f.leases.renew(f.first.sessionId, 1, { ...f.identity, machineExpiresAt: 200_000 }, "device"), /unavailable/);
    assert.equal(f.stopped(), 1); f.leases.destroy();
  }
});
test("absolute session cap cannot be moved by repeated short grants", t => {
  const f = fixture(); t.after(() => f.leases.destroy());
  let lease = f.first;
  for (let i = 0; i < 70; i++) {
    f.advance(100_000);
    lease = f.leases.renew(lease.sessionId, lease.generation, { ...f.identity, machineExpiresAt: lease.expiresAt + 100_000 }, "device");
  }
  f.advance(100_000);
  assert.throws(() => f.leases.renew(lease.sessionId, lease.generation,
    { ...f.identity, machineExpiresAt: lease.expiresAt + 100_000 }, "device"), /deadline_invalid/);
});

test("one live v2 Hub Task cannot acquire a second device or changed runtime binding", t => {
  const leases = new MachineSessionLeases({ clock: () => 1000 }); t.after(() => leases.destroy());
  const binding = { issuer: "https://synthetic.example.test", subject: "machine", roomId: "room-one",
    taskId: "task-one", tenantId: "tenant-one", projectId: "project-one", protocolVersion: "v2",
    runtimeId: "runtime-one", hubSessionId: "session-one", capabilitySet: "screen.publish" };
  const identity = { machineBinding: binding, machineExpiresAt: 121000 };
  const first = leases.issue(identity, "device-one");
  // Reserve before WebSocket attach, so concurrent admission cannot race tickets.
  for (const mutation of [{}, { runtimeId: "runtime-two" }, { hubSessionId: "session-two" },
    { roomId: "room-two" }, { capabilitySet: "chat.send" }, { subject: "other" }]) {
    assert.throws(() => leases.issue({ ...identity, machineBinding: { ...binding, ...mutation } }, "device-two"),
      /machine_session_already_active/);
  }
  let stopped = 0;
  leases.attach(first.sessionId, () => true, () => { stopped++; });
  assert.throws(() => leases.issue(identity, "device-two"), /machine_session_already_active/);
  assert.equal(leases.live(first.sessionId), true); assert.equal(stopped, 0);
  // Existing authoritative close releases capacity; it does not issue a grant.
  leases.close(first.sessionId); assert.equal(stopped, 1);
  assert.notEqual(leases.issue(identity, "device-two").sessionId, first.sessionId);
});

test("v2 task occupancy is scoped by issuer, tenant, project and task; v1 stays compatible", t => {
  const leases = new MachineSessionLeases({ clock: () => 1000 }); t.after(() => leases.destroy());
  const binding = { issuer: "https://synthetic.example.test", subject: "machine", roomId: "room-one",
    taskId: "task-one", tenantId: "tenant-one", projectId: "project-one", protocolVersion: "v2",
    runtimeId: "runtime-one", hubSessionId: "session-one", capabilitySet: "screen.publish" };
  const identity = { machineBinding: binding, machineExpiresAt: 121000 };
  leases.issue(identity, "device-one");
  for (const field of ["issuer", "tenantId", "projectId", "taskId"]) {
    assert.ok(leases.issue({ ...identity, machineBinding: { ...binding, [field]: "different" } }, "device-one"));
  }
  const legacy = { ...identity, machineBinding: { ...binding, protocolVersion: "v1", runtimeId: "", hubSessionId: "" } };
  leases.issue(legacy, "device-one"); leases.issue(legacy, "device-two");
  assert.throws(() => leases.issue(legacy, "device-one"), /machine_session_already_active/);
});
