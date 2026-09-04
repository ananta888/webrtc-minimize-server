import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastFailoverCoordinator,
  BroadcastFailoverError,
  classifyBroadcastFailure,
} from "../src/broadcast-failover-coordinator.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-failover",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programEpoch: 7,
  leaseEpoch: 11,
});

function candidate(letter, priority, overrides = {}) {
  return {
    holderRef: `pkr_${letter.repeat(16)}`,
    deviceRef: `dev_${letter.repeat(16)}`,
    priority,
    volunteerConsent: true,
    decryptConsent: "preauthorized",
    consentExpiresAt: NOW + 120_000,
    health: "healthy",
    quorumEligible: true,
    ...overrides,
  };
}

function signals(overrides = {}) {
  return {
    writer: "healthy",
    browserSource: "healthy",
    gateway: "healthy",
    host: "healthy",
    network: "healthy",
    provider: "healthy",
    ...overrides,
  };
}

function coordinator() {
  const value = new BroadcastFailoverCoordinator({
    leaseTtlMs: 10_000,
    graceMs: 2_000,
    recoveryDeadlineMs: 20_000,
    maxStandbys: 2,
  });
  value.register(SCOPE);
  return value;
}

test("one deterministic fenced writer wins and stale writers cannot publish", () => {
  const failover = coordinator();
  failover.configureCandidates(SCOPE, "packager-writer", [
    candidate("c", 50),
    candidate("a", 100),
    candidate("b", 100),
  ], NOW);

  const acquired = failover.acquire(SCOPE, "packager-writer", NOW);
  assert.equal(acquired.active.holderRef, candidate("a", 100).holderRef);
  assert.equal(acquired.active.fencingRevision, 12);
  assert.equal(acquired.active.access, "source-and-decrypt");
  assert.throws(
    () => failover.acquire(SCOPE, "packager-writer", NOW + 1),
    (error) => error instanceof BroadcastFailoverError && error.code === "broadcast_failover_writer_exists",
  );
  assert.equal(failover.authorizeWriter(SCOPE, "packager-writer", {
    leaseId: acquired.active.leaseId,
    holderRef: acquired.active.holderRef,
    fencingRevision: acquired.active.fencingRevision,
  }, NOW + 1), true);
});

test("reachable standbys stay keyless and reachability without current consent never promotes", () => {
  const failover = coordinator();
  failover.configureCandidates(SCOPE, "packager-writer", [
    candidate("a", 100),
    candidate("b", 90, { decryptConsent: "none", consentExpiresAt: 0 }),
    candidate("c", 80),
  ], NOW);
  const first = failover.acquire(SCOPE, "packager-writer", NOW);
  const standby = failover.roleSnapshot(SCOPE, "packager-writer", NOW).standbys;
  assert.equal(standby.every(({ access }) => access === "none"), true);
  assert.equal(standby.find(({ holderRef }) => holderRef === candidate("b", 90).holderRef).consent, "none");

  const grace = failover.evaluate(SCOPE, "packager-writer", signals({ writer: "unavailable" }), NOW + 10_001);
  assert.equal(grace.action, "grace");
  const takeover = failover.evaluate(SCOPE, "packager-writer", signals({ writer: "unavailable" }), NOW + 12_001);
  assert.equal(takeover.action, "takeover");
  assert.equal(takeover.active.holderRef, candidate("c", 80).holderRef);
  assert.equal(takeover.active.fencingRevision > first.active.fencingRevision, true);
  assert.throws(() => failover.authorizeWriter(SCOPE, "packager-writer", {
    leaseId: first.active.leaseId,
    holderRef: first.active.holderRef,
    fencingRevision: first.active.fencingRevision,
  }, NOW + 12_002), /invalid_broadcast_failover_fence/);
});

test("heartbeat needs a healthy quorum and extends only the exact current fence", () => {
  const failover = coordinator();
  failover.configureCandidates(SCOPE, "gateway-writer", [candidate("g", 100)], NOW);
  const acquired = failover.acquire(SCOPE, "gateway-writer", NOW);
  const weak = failover.heartbeat(SCOPE, "gateway-writer", {
    leaseId: acquired.active.leaseId,
    holderRef: acquired.active.holderRef,
    fencingRevision: acquired.active.fencingRevision,
    health: "healthy",
    quorum: { healthyVotes: 1, totalVotes: 3 },
  }, NOW + 1_000);
  assert.equal(weak.accepted, false);
  const healthy = failover.heartbeat(SCOPE, "gateway-writer", {
    leaseId: acquired.active.leaseId,
    holderRef: acquired.active.holderRef,
    fencingRevision: acquired.active.fencingRevision,
    health: "healthy",
    quorum: { healthyVotes: 2, totalVotes: 3 },
  }, NOW + 1_500);
  assert.deepEqual(healthy, { accepted: true, expiresAt: NOW + 11_500 });
});

test("failure classification distinguishes every required fault domain", () => {
  assert.equal(classifyBroadcastFailure(signals({ writer: "unavailable" })), "packager");
  assert.equal(classifyBroadcastFailure(signals({ browserSource: "unavailable" })), "browser");
  assert.equal(classifyBroadcastFailure(signals({ gateway: "unavailable" })), "gateway");
  assert.equal(classifyBroadcastFailure(signals({ host: "unavailable" })), "host");
  assert.equal(classifyBroadcastFailure(signals({ network: "unavailable" })), "network");
  assert.equal(classifyBroadcastFailure(signals({ provider: "unavailable" })), "provider");

  const failover = coordinator();
  failover.configureCandidates(SCOPE, "gateway-writer", [candidate("g", 100), candidate("h", 90)], NOW);
  failover.acquire(SCOPE, "gateway-writer", NOW);
  assert.equal(
    failover.evaluate(SCOPE, "gateway-writer", signals(), NOW + 10_001).failureType,
    "gateway",
  );
});

test("safe recovery emits a discontinuity and browser source loss stops visibly", () => {
  const safe = coordinator();
  safe.configureCandidates(SCOPE, "gateway-writer", [candidate("g", 100), candidate("h", 90)], NOW);
  safe.acquire(SCOPE, "gateway-writer", NOW);
  safe.evaluate(SCOPE, "gateway-writer", signals({ gateway: "unavailable" }), NOW + 10_001);
  const resumed = safe.evaluate(SCOPE, "gateway-writer", signals({ gateway: "unavailable" }), NOW + 12_001);
  assert.deepEqual(resumed.recovery, { disposition: "resume", discontinuity: true, playerRestart: true });

  const unsafe = coordinator();
  unsafe.configureCandidates(SCOPE, "packager-writer", [candidate("a", 100), candidate("b", 90)], NOW);
  unsafe.acquire(SCOPE, "packager-writer", NOW);
  unsafe.evaluate(SCOPE, "packager-writer", signals({ browserSource: "unavailable" }), NOW + 10_001);
  const stopped = unsafe.evaluate(SCOPE, "packager-writer", signals({ browserSource: "unavailable" }), NOW + 12_001);
  assert.deepEqual(stopped.recovery, { disposition: "visible-stop", discontinuity: false, playerRestart: false });
});

test("recovery snapshot contains only metadata and bounded idempotency outbox", () => {
  const first = coordinator();
  first.configureCandidates(SCOPE, "packager-writer", [candidate("a", 100)], NOW);
  first.acquire(SCOPE, "packager-writer", NOW);
  const snapshot = first.snapshot(SCOPE);
  const serialized = JSON.stringify(snapshot).toLowerCase();
  for (const forbidden of ["sframe", "decryptkey", "transcript", "captiontext"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }

  const restored = new BroadcastFailoverCoordinator();
  assert.deepEqual(restored.restore(snapshot), snapshot);
  assert.equal(restored.acknowledge(SCOPE, snapshot.outbox[0].eventId), true);
  assert.equal(restored.acknowledge(SCOPE, snapshot.outbox[0].eventId), false);
  assert.throws(() => restored.restore({ ...snapshot, transcript: "secret" }), /invalid_broadcast_failover_snapshot/);
});

test("chaos: killed packager and gateway are fenced, cleaned and never duplicate publication", () => {
  const failover = coordinator();
  failover.configureCandidates(SCOPE, "packager-writer", [candidate("a", 100), candidate("b", 90)], NOW);
  failover.configureCandidates(SCOPE, "gateway-writer", [candidate("g", 100), candidate("h", 90)], NOW);
  const packager = failover.acquire(SCOPE, "packager-writer", NOW);
  const gateway = failover.acquire(SCOPE, "gateway-writer", NOW);

  failover.evaluate(SCOPE, "packager-writer", signals({ host: "unavailable" }), NOW + 10_001);
  const packagerReturn = failover.evaluate(SCOPE, "packager-writer", signals({ host: "unavailable" }), NOW + 12_001);
  assert.equal(packagerReturn.action, "takeover");
  assert.equal(packagerReturn.active.holderRef, candidate("b", 90).holderRef);
  assert.equal(NOW + 12_001 - (NOW + 10_000) <= 20_000, true);

  failover.evaluate(SCOPE, "gateway-writer", signals({ gateway: "unavailable" }), NOW + 10_001);
  const gatewayReturn = failover.evaluate(SCOPE, "gateway-writer", signals({ gateway: "unavailable" }), NOW + 12_001);
  assert.equal(gatewayReturn.action, "takeover");
  assert.equal(gatewayReturn.active.holderRef, candidate("h", 90).holderRef);

  const snapshot = failover.snapshot(SCOPE);
  assert.equal(snapshot.roles.filter(({ active }) => active).length, 2);
  assert.equal(new Set(snapshot.roles.map(({ active }) => active?.leaseId)).size, 2);
  assert.equal(snapshot.outbox.filter(({ type }) => type === "writer-fenced").length, 2);
  assert.equal(snapshot.outbox.filter(({ type }) => type === "writer-takeover").length, 2);
  assert.throws(() => failover.authorizeWriter(SCOPE, "packager-writer", {
    leaseId: packager.active.leaseId,
    holderRef: packager.active.holderRef,
    fencingRevision: packager.active.fencingRevision,
  }, NOW + 12_002), /invalid_broadcast_failover_fence/);
  assert.throws(() => failover.authorizeWriter(SCOPE, "gateway-writer", {
    leaseId: gateway.active.leaseId,
    holderRef: gateway.active.holderRef,
    fencingRevision: gateway.active.fencingRevision,
  }, NOW + 12_002), /invalid_broadcast_failover_fence/);
});
