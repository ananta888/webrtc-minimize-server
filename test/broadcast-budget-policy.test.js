import assert from "node:assert/strict";
import test from "node:test";

import {
  BROADCAST_SLOS,
  evaluateBroadcastBudget,
  PrivacyPreservingViewerCounter,
} from "../src/broadcast-budget-policy.js";

const zero = { viewerSessions: 0, egressBitsPerSecond: 0, encoderSlots: 0, encoderMinutes: 0, programMinutes: 0, costMicros: 0 };
const limits = {
  deployment: { viewerSessions: 1_000, egressBitsPerSecond: 1_000_000_000, encoderSlots: 20, encoderMinutes: 20_000, programMinutes: 30_000, costMicros: 1_000_000_000 },
  tenant: { viewerSessions: 500, egressBitsPerSecond: 500_000_000, encoderSlots: 10, encoderMinutes: 10_000, programMinutes: 15_000, costMicros: 500_000_000 },
  principal: { viewerSessions: 100, egressBitsPerSecond: 100_000_000, encoderSlots: 3, encoderMinutes: 1_000, programMinutes: 2_000, costMicros: 50_000_000 },
};

function request(overrides = {}) {
  return {
    tenantId: "tn_aaaaaaaaaaaaaaaa", principalRef: "sub_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa",
    requested: { viewerSessions: 20, egressBitsPerSecond: 90_000_000, encoderSlots: 3, encoderMinutes: 180, programMinutes: 60, costMicros: 0 },
    usage: { deployment: zero, tenant: zero, principal: zero }, limits, softLimitRatio: 0.8,
    ...overrides,
  };
}

test("budget policy admits per-scope resources and exposes a preflight capacity class", () => {
  const result = evaluateBroadcastBudget(request());
  assert.equal(result.admitted, true);
  assert.equal(result.capacityClass, "origin-small");
  assert.ok(result.warnings.includes("principal:egressBitsPerSecond:soft-limit"));
});

test("hard tenant, principal and deployment budgets fail independently without a room-count limit", () => {
  for (const [scope, metric] of [["tenant", "costMicros"], ["principal", "encoderSlots"], ["deployment", "viewerSessions"]]) {
    const value = request();
    value.usage = { ...value.usage, [scope]: { ...zero, [metric]: limits[scope][metric] } };
    value.requested = { ...value.requested, [metric]: Math.max(1, value.requested[metric]) };
    assert.throws(() => evaluateBroadcastBudget(value), new RegExp(`broadcast_${scope}_${metric}_budget_exhausted`));
  }
  assert.doesNotMatch(JSON.stringify(limits), /room/i);
});

test("SLOs are profile-specific and remain unverified until browser load evidence exists", () => {
  for (const slo of Object.values(BROADCAST_SLOS)) {
    assert.equal(slo.runtimeVerified, false);
    assert.ok(slo.measurementWindowMinutes >= 5);
    assert.ok(slo.errorBudgetMinutesPer30Days > 0);
  }
});

test("viewer counter deduplicates opaque sessions without IP or device fingerprint", () => {
  const counter = new PrivacyPreservingViewerCounter({ key: Buffer.alloc(32, 7), leaseMs: 5_000 });
  const program = "prg_aaaaaaaaaaaaaaaa";
  assert.equal(counter.observe(program, "pbs_aaaaaaaaaaaaaaaaaaaaaaaa", 1_000), 1);
  assert.equal(counter.observe(program, "pbs_aaaaaaaaaaaaaaaaaaaaaaaa", 2_000), 1);
  assert.equal(counter.observe(program, "pbs_bbbbbbbbbbbbbbbbbbbbbbbb", 2_000), 2);
  assert.equal(counter.count(program, 7_001), 0);
  assert.doesNotMatch(JSON.stringify(counter), /pbs_|ip|fingerprint/i);
  counter.destroy();
});
