import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastProgramCapacity, BROADCAST_PROGRAM_CAPACITY_DEFAULTS, normalizeBroadcastProgramCapacity } from "../src/broadcast-program-capacity.js";
import { loadConfig } from "../src/config.js";

const a = { tenantId: "tn_aaaaaaaaaaaaaaaa", principalRef: "sub_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa" };
const b = { ...a, programId: "prg_bbbbbbbbbbbbbbbb" };

test("same-program pending, active, update and handoff scopes count exactly once", () => {
  const policy = new BroadcastProgramCapacity({ deployment: 1, gateway: 1, tenant: 1, principal: 1 });
  assert.equal(policy.allows(a, []), true);
  assert.equal(policy.allows(a, [a, { ...a }]), true);
  assert.equal(policy.allows(b, [a]), false);
  assert.equal(policy.allows({ ...a, principalRef: "sub_bbbbbbbbbbbbbbbb" }, [a]), false);
});

test("tenant and principal isolation does not become an unlimited deployment or gateway", () => {
  const policy = new BroadcastProgramCapacity({ deployment: 3, gateway: 3, tenant: 2, principal: 1 });
  const second = { ...b, principalRef: "sub_bbbbbbbbbbbbbbbb" };
  const third = { ...a, tenantId: "tn_bbbbbbbbbbbbbbbb" };
  assert.equal(policy.allows(b, [a]), false);
  assert.equal(policy.allows(second, [a]), true);
  assert.equal(policy.allows(third, [a, second]), true);
  assert.equal(policy.allows({ ...a, principalRef: "sub_cccccccccccccccc", programId: "prg_cccccccccccccccc" }, [a, second]), false);
  assert.equal(policy.allows({ ...third, programId: b.programId, principalRef: second.principalRef }, [a, second, third]), false);
  assert.deepEqual(a, { tenantId: "tn_aaaaaaaaaaaaaaaa", principalRef: "sub_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa" });
});

test("malformed internal scope, expanded fields and oversized inventory fail closed", () => {
  const policy = new BroadcastProgramCapacity();
  for (const bad of [null, [], {}, { ...a, extra: true }, { ...a, tenantId: "raw-tenant" },
    { ...a, principalRef: "raw-principal" }, { ...a, programId: "raw-program" }, { ...a, tenantId: [a.tenantId] }]) {
    assert.equal(policy.allows(bad, []), false);
    assert.equal(policy.allows(a, [bad]), false);
  }
  assert.equal(policy.allows(a, null), false);
  assert.equal(policy.allows(a, Array(20_001).fill(a)), false);
  for (const bad of [null, [], { unknown: 1 }, { tenant: 0 }, { gateway: 1.5 }, { deployment: 10_001 }, { principal: Infinity }]) {
    assert.throws(() => normalizeBroadcastProgramCapacity(bad), /invalid_broadcast_program_capacity/);
  }
});

test("environment defaults, exact bounds and immutable operator limits stay consistent", () => {
  assert.deepEqual(loadConfig({}).broadcastProgramCapacity, BROADCAST_PROGRAM_CAPACITY_DEFAULTS);
  assert.equal(Object.isFrozen(loadConfig({}).broadcastProgramCapacity), true);
  for (const [scope, env] of [["deployment", "BROADCAST_MAX_ACTIVE_PROGRAMS"], ["gateway", "BROADCAST_MAX_ACTIVE_PROGRAMS_PER_GATEWAY"],
    ["tenant", "BROADCAST_MAX_ACTIVE_PROGRAMS_PER_TENANT"], ["principal", "BROADCAST_MAX_ACTIVE_PROGRAMS_PER_PRINCIPAL"]]) {
    for (const valid of [1, 10_000]) assert.equal(loadConfig({ [env]: String(valid) }).broadcastProgramCapacity[scope], valid);
    for (const bad of ["0", "-1", "10001", "Infinity", "NaN", "1.5", "false"]) {
      assert.throws(() => loadConfig({ [env]: bad }), new RegExp(env));
    }
  }
});
