import assert from "node:assert/strict";
import test from "node:test";
import { MachineSessionLeases } from "../src/machine-session-leases.js";

const nonce = "a".repeat(32);
const binding = Object.freeze({ issuer: "https://synthetic.test", subject: "machine:ananta",
  roomId: "room-0123456789abcdef01", taskId: "task", tenantId: "tenant", projectId: "project",
  protocolVersion: "v2", runtimeId: "runtime", hubSessionId: "hub-session", capabilitySet: "screen.publish" });
const identity = { machineBinding: binding, machineExpiresAt: 121000 };

function fixture(t, { attach = true, detach = true } = {}) {
  const leases = new MachineSessionLeases({ clock: () => 1000 });
  t.after(() => leases.destroy());
  const lease = leases.issue(identity, "device"); let member = true;
  const events = [];
  if (attach) leases.attach(lease.sessionId, () => member, () => events.push("stop"), null, null,
    detach === null ? null : () => {
      events.push("detach");
      if (detach instanceof Error) throw detach;
      if (detach === true) member = false;
      return detach;
    });
  return { leases, lease, events, retire: (who = identity, id = lease.sessionId, n = nonce) => leases.retire(id, who, n) };
}

test("exact retirement detaches before stop and yields a closed immutable receipt", t => {
  const f = fixture(t);
  const receipt = f.retire();
  assert.deepEqual(receipt, { schema: "ananta.meet-session-retired.v1", nonce,
    sessionId: f.lease.sessionId, binding, retired: true });
  assert.equal(Object.isFrozen(receipt), true); assert.equal(Object.isFrozen(receipt.binding), true);
  assert.deepEqual(f.events, ["detach", "stop"]);
  assert.equal(f.leases.live(f.lease.sessionId), false);
  assert.throws(() => f.leases.renew(f.lease.sessionId, 1, { ...identity, machineExpiresAt: 150000 }, "device"), /unavailable/);
  assert.throws(() => f.leases.attach(f.lease.sessionId, () => true, () => {}), /unavailable/);
});

test("each immutable scope substitution is rejected before reading membership or detach", t => {
  const f = fixture(t);
  for (const key of Object.keys(binding)) {
    assert.throws(() => f.retire({ ...identity, machineBinding: { ...binding, [key]: "foreign" } }), /scope_invalid/);
    assert.deepEqual(f.events, []); assert.equal(f.leases.live(f.lease.sessionId), true);
  }
});

for (const detach of [false, null, "true", 1, new Error("private detail")]) {
  test(`uncertain detach keeps original occupancy (${String(detach)})`, t => {
    const f = fixture(t, { detach });
    assert.throws(f.retire, /^Error: machine_session_retirement_unconfirmed$/);
    assert.equal(f.leases.live(f.lease.sessionId), true);
    assert.throws(() => f.leases.issue(identity, "other-device"), /already_active/);
    assert.equal(f.events.includes("stop"), false);
  });
}

test("pending ticket retirement and old receipt replay cannot remove a replacement", t => {
  const f = fixture(t, { attach: false }); const original = f.retire();
  assert.deepEqual(f.events, []);
  const replacement = f.leases.issue(identity, "replacement-device");
  assert.notEqual(replacement.sessionId, f.lease.sessionId);
  assert.deepEqual(f.retire(), original);
  assert.equal(f.leases.live(replacement.sessionId), true);
  assert.throws(() => f.leases.attach(f.lease.sessionId, () => true, () => {}), /unavailable/);
});

test("absent ID proves absence under the caller binding, never previous ownership", t => {
  const f = fixture(t); const absent = "ms_" + "b".repeat(32);
  assert.equal(f.retire(identity, absent).sessionId, absent);
  assert.equal(f.leases.live(f.lease.sessionId), true); assert.deepEqual(f.events, []);
  assert.throws(() => f.retire({ ...identity, machineBinding: { ...binding, protocolVersion: "v1" } }, absent), /scope_invalid/);
});

test("invalid session IDs, nonce and missing bindings cannot mutate a live session", t => {
  const f = fixture(t);
  for (const id of [null, 1, {}, "ms_bad", "../session"]) assert.throws(() => f.retire(identity, id), /scope_invalid/);
  for (const value of [null, 1, [], "", "a".repeat(33)]) assert.throws(() => f.retire(identity, f.lease.sessionId, value), /scope_invalid/);
  for (const who of [null, {}, { machineBinding: {} }]) assert.throws(() => f.retire(who), /scope_invalid/);
  assert.deepEqual(f.events, []); assert.equal(f.leases.live(f.lease.sessionId), true);
});
