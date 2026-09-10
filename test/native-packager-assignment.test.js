import assert from "node:assert/strict";
import test from "node:test";

import {
  NativePackagerAssignmentError,
  NativePackagerAssignmentRegistry,
} from "../src/native-packager-assignment.js";
import { admitNativePackager, NATIVE_BROADCAST_PROFILE } from "../src/native-packager-policy.js";

const NOW = 1_800_000_000_000;
const OWNER = "https://identity.example/realms/ananta|owner";
const PACKAGER = "pkr_aaaaaaaaaaaaaaaa";
const PUBLISHER = "0123456789abcdef";

function capability(overrides = {}) {
  return {
    capabilityVersion: 1,
    agentId: PACKAGER,
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa",
    deviceRef: "dev_aaaaaaaaaaaaaaaa",
    agentVersion: "1.0.0",
    ffmpegVersion: "6.1.1",
    videoEncoders: ["libx264", "h264_nvenc"],
    audioEncoders: ["aac"],
    hardwareClass: "large",
    cpuClass: "high",
    gpuClass: "dedicated",
    uploadClass: "over-15mbit",
    energyClass: "ac",
    health: "healthy",
    maximumRenditions: 3,
    maximumPixelsPerSecond: 1280 * 720 * 30,
    consentedRoomIds: ["room-alpha"],
    observedAt: NOW,
    expiresAt: NOW + 30_000,
    ...overrides,
  };
}

function request() {
  return {
    requestVersion: 1,
    trigger: "user-action",
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    resourceRef: "res_aaaaaaaaaaaaaaaa",
    requestedRenditions: 3,
    allowHardwareAcceleration: true,
  };
}

function registry(candidate = { id: PACKAGER, online: true, capability: capability() }, options = {}) {
  return new NativePackagerAssignmentRegistry({
    ...options,
    controlRegistry: {
      candidate(owner, packager) {
        if (owner !== OWNER || packager !== PACKAGER) throw new Error("not_found");
        return candidate;
      },
    },
    idFactory: () => "asn_aaaaaaaaaaaaaaaa",
    iceServersForPackager: () => [{
      urls: ["turn:turn.example.test:3478?transport=udp"],
      username: "1800000600:test",
      credential: "short-lived-credential",
      credentialType: "password",
    }],
  });
}

for (const field of ["cpuUnits", "memoryMiB", "encoderSlots", "gpuSlots", "egressBitsPerSecond"]) {
  test(`operator ${field} limit rejects native admission and direct prepare before assignment allocation`, () => {
    const candidate = { id: PACKAGER, online: true, capability: capability() };
    const assignments = registry(candidate, { resourceLimits: { [field]: 0 } });
    const input = request();
    const admission = admitNativePackager(candidate.capability, input, NOW);
    const denied = error => error instanceof NativePackagerAssignmentError
      && error.code === "broadcast_temporarily_unavailable" && error.status === 429;
    assert.throws(() => assignments.admit(OWNER, PACKAGER, input, NOW), denied);
    assert.throws(() => assignments.prepare(OWNER, PACKAGER, admission, {
      leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
    }, PUBLISHER, NOW), denied);
    assert.equal(assignments.activeForPackager(PACKAGER), null);
    assert.equal(assignments.list(OWNER).length, 0);
  });
}

for (const release of ["stop-ack", "connection-loss"]) test(`aggregate native resource occupancy survives draining and ${release}`, () => {
  let now = NOW, sequence = 0;
  const assignments = new NativePackagerAssignmentRegistry({ resourceLimits: { encoderSlots: 1 },
    controlRegistry: { candidate: (_owner, id) => ({ id, online: true,
      capability: capability({ agentId: id, observedAt: now, expiresAt: now + 30000 }) }) },
    idFactory: () => `asn_${String(++sequence).padStart(16, "a")}`,
    iceServersForPackager: () => [{ urls: ["stun:synthetic.invalid:3478"] }],
  });
  const firstId = PACKAGER, secondId = "pkr_bbbbbbbbbbbbbbbb";
  const firstRequest = { ...request(), requestedRenditions: 1, allowHardwareAcceleration: false };
  const secondRequest = { ...firstRequest, programId: "prg_bbbbbbbbbbbbbbbb", resourceRef: "res_bbbbbbbbbbbbbbbb" };
  const firstAdmission = assignments.admit(OWNER, firstId, firstRequest, now);
  const secondAdmission = assignments.admit(OWNER, secondId, secondRequest, now);
  const lease = { leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: now + 60000 };
  const first = assignments.prepare(OWNER, firstId, firstAdmission, lease, PUBLISHER, now);
  const blocked = () => {
    assert.throws(() => assignments.admit(OWNER, secondId, secondRequest, now), /broadcast_temporarily_unavailable/);
    assert.throws(() => assignments.prepare(OWNER, secondId, secondAdmission, { ...lease, expiresAt: now + 60000 }, PUBLISHER, now),
      /broadcast_temporarily_unavailable/, "pre-admission is not a reservation or permission to bypass commit capacity");
    assert.equal(assignments.activeForPackager(secondId), null);
  };
  const acknowledge = state => assignments.acknowledge(firstId, { version: 1, type: "assignment-status",
    assignmentId: first.snapshot.assignmentId, programEpoch: first.snapshot.programEpoch,
    fencingRevision: first.snapshot.fencingRevision, state, reasonCode: "SYNTHETIC_ACK", observedAt: now }, now);
  blocked();
  for (const state of ["ready", "starting", "running"]) acknowledge(state);
  assignments.stop(OWNER, firstId, first.snapshot.assignmentId, "OWNER_STOP", now); blocked();
  if (release === "stop-ack") acknowledge("stopped");
  else {
    assignments.failPackager(firstId, "CONTROL_DISCONNECTED", now); blocked();
    now = lease.expiresAt - 1; blocked();
    now = lease.expiresAt;
  }
  const current = assignments.admit(OWNER, secondId, secondRequest, now);
  const second = assignments.prepare(OWNER, secondId, current, { ...lease, expiresAt: now + 60000 }, PUBLISHER, now);
  assert.equal(second.snapshot.state, "preparing");
  assert.throws(() => acknowledge("running"), /transition|expired/, "late former writer cannot recover resource authority");
});

test("reentrant ICE preparation cannot bypass the final resource commit check", () => {
  let sequence = 0, nested = false, successor;
  const assignments = new NativePackagerAssignmentRegistry({ resourceLimits: { encoderSlots: 1 },
    controlRegistry: { candidate: (_owner, id) => ({ id, online: true, capability: capability({ agentId: id }) }) },
    idFactory: () => `asn_${String(++sequence).padStart(16, "a")}`,
    iceServersForPackager: () => {
      if (!nested) { nested = true; successor = prepare("pkr_bbbbbbbbbbbbbbbb", "prg_bbbbbbbbbbbbbbbb"); }
      return [{ urls: ["stun:synthetic.invalid:3478"] }];
    },
  });
  const prepare = (id, programId) => assignments.prepare(OWNER, id, assignments.admit(OWNER, id,
    { ...request(), programId, requestedRenditions: 1, allowHardwareAcceleration: false }, NOW),
  { leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60000 }, PUBLISHER, NOW);
  assert.throws(() => prepare(PACKAGER, request().programId), /broadcast_temporarily_unavailable/);
  assert.equal(assignments.activeForPackager(PACKAGER), null);
  assert.equal(assignments.list(OWNER).length, 1);
  assert.equal(assignments.activeForPackager(successor.snapshot.packagerId).assignmentId, successor.snapshot.assignmentId);
});

test("assignment wire carries only the aggregate-budget-admitted rendition prefix", () => {
  const assignments = registry(), admission = assignments.admit(OWNER, PACKAGER, request(), NOW);
  const prepared = assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);
  assert.deepEqual(prepared.snapshot.renditionIds, ["low", "medium"]);
  assert.deepEqual(prepared.command.profile.renditions.map(r => r.id), prepared.snapshot.renditionIds);
  assert.ok(prepared.command.profile.renditions.reduce((sum, r) => sum + r.width * r.height * r.framesPerSecond, 0)
    <= capability().maximumPixelsPerSecond);
});

test("assignment preparation is owner-, consent-, capability- and lease-fenced", () => {
  const maximumPixelsPerSecond = NATIVE_BROADCAST_PROFILE.renditions.reduce((sum, r) => sum + r.width * r.height * r.framesPerSecond, 0);
  const assignments = registry({ id: PACKAGER, online: true, capability: capability({ maximumPixelsPerSecond }) });
  const admission = assignments.admit(OWNER, PACKAGER, request(), NOW);
  const prepared = assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa",
    fencingRevision: 9,
    expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);

  assert.deepEqual(prepared.snapshot.renditionIds, ["low", "medium", "high"]);
  assert.equal(prepared.snapshot.state, "preparing");
  assert.equal(prepared.command.type, "assignment-prepare");
  assert.equal(prepared.command.version, 3);
  assert.equal(prepared.command.publisherPeerId, PUBLISHER);
  assert.equal(prepared.command.profile.videoEncoder, "h264_nvenc");
  assert.equal(prepared.command.profile.softwareFallback, "libx264");
  assert.equal(prepared.command.profile.maximumQueueFrames, 60);
  assert.equal(prepared.command.profile.renditions[2].videoBitsPerSecond, 2_400_000);
  assert.deepEqual(prepared.command.iceServers, [{
    urls: ["turn:turn.example.test:3478?transport=udp"],
    username: "1800000600:test",
    credential: "short-lived-credential",
    credentialType: "password",
  }]);
  assert.deepEqual(assignments.activeForProgram(request().programId), prepared.snapshot);
  const signal = {
    packagerId: PACKAGER,
    assignmentId: prepared.snapshot.assignmentId,
    programId: prepared.snapshot.programId,
    programEpoch: prepared.snapshot.programEpoch,
    fencingRevision: prepared.snapshot.fencingRevision,
  };
  assert.equal(assignments.authorizeBrowserSignal({
    id: PUBLISHER, principal: OWNER, roomId: "room-alpha",
  }, signal, NOW).assignmentId, prepared.snapshot.assignmentId);
  assert.equal(assignments.authorizePackagerSignal(PACKAGER, signal, NOW).publisherPeerId, PUBLISHER);
  assert.throws(() => assignments.authorizeBrowserSignal({
    id: "fedcba9876543210", principal: OWNER, roomId: "room-alpha",
  }, signal, NOW), /stale_native_packager_signal/);
  assert.throws(
    () => assignments.prepare(OWNER, PACKAGER, admission, {
      leaseId: "lea_bbbbbbbbbbbbbbbb", fencingRevision: 10, expiresAt: NOW + 60_000,
    }, PUBLISHER, NOW),
    (error) => error instanceof NativePackagerAssignmentError && error.code === "native_packager_assignment_conflict",
  );
});

test("legacy agents receive v1 software assignments without silently selected hardware", () => {
  const legacyCapability = capability({ agentVersion: "0.5.0" });
  const assignments = registry({ id: PACKAGER, online: true, capability: legacyCapability });
  const admission = assignments.admit(OWNER, PACKAGER, request(), NOW);
  assert.equal(admission.videoEncoder, "libx264");
  const prepared = assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);
  assert.equal(prepared.command.version, 1);
  assert.equal(Object.hasOwn(prepared.command.profile, "videoEncoder"), false);
  assert.equal(Object.hasOwn(prepared.command.profile, "softwareFallback"), false);
});

test("agent 0.6 receives v2 without ICE credentials and malformed v3 ICE fails closed", () => {
  const v2Assignments = registry({ id: PACKAGER, online: true, capability: capability({ agentVersion: "0.6.9" }) });
  const admission = v2Assignments.admit(OWNER, PACKAGER, request(), NOW);
  const prepared = v2Assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);
  assert.equal(prepared.command.version, 2);
  assert.equal(Object.hasOwn(prepared.command, "iceServers"), false);

  const invalid = new NativePackagerAssignmentRegistry({
    controlRegistry: { candidate: () => ({ id: PACKAGER, online: true, capability: capability() }) },
    idFactory: () => "asn_bbbbbbbbbbbbbbbb",
    iceServersForPackager: () => [{ urls: ["https://not-ice.example.test"] }],
  });
  assert.throws(() => invalid.prepare(OWNER, PACKAGER, invalid.admit(OWNER, PACKAGER, request(), NOW), {
    leaseId: "lea_bbbbbbbbbbbbbbbb", fencingRevision: 10, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW), /invalid_native_packager_ice_configuration/);
});

test("assignment status rejects stale fences and follows a closed lifecycle", () => {
  const assignments = registry();
  const admission = admitNativePackager(capability(), request(), NOW);
  assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);
  const status = (state, reasonCode, overrides = {}) => ({
    version: 1,
    type: "assignment-status",
    assignmentId: "asn_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    fencingRevision: 9,
    state,
    reasonCode,
    observedAt: NOW + 1,
    ...overrides,
  });

  assert.equal(assignments.acknowledge(PACKAGER, status("ready", "CAPABILITY_READY"), NOW + 1).state, "ready");
  assert.throws(
    () => assignments.acknowledge(PACKAGER, status("running", "PIPELINE_RUNNING", { fencingRevision: 8 }), NOW + 1),
    /stale_native_packager_assignment/,
  );
  assert.equal(assignments.acknowledge(PACKAGER, status("starting", "MEDIA_STARTING"), NOW + 1).state, "starting");
  assert.equal(assignments.acknowledge(PACKAGER, status("running", "PIPELINE_RUNNING"), NOW + 1).state, "running");
  assert.throws(
    () => assignments.stop(OWNER, "pkr_bbbbbbbbbbbbbbbb", "asn_aaaaaaaaaaaaaaaa", "OWNER_STOP", NOW + 2),
    /native_packager_assignment_not_found/,
  );
  const stopping = assignments.stop(OWNER, PACKAGER, "asn_aaaaaaaaaaaaaaaa", "OWNER_STOP", NOW + 2);
  assert.equal(stopping.command.type, "assignment-stop");
  assert.equal(stopping.snapshot.state, "draining");
  assert.equal(assignments.renew(PACKAGER, NOW + 2), null,
    "a draining assignment must never renew already revoked writer leases");
  assert.equal(assignments.stop(OWNER, PACKAGER, "asn_aaaaaaaaaaaaaaaa", "OWNER_STOP", NOW + 2).command, null,
    "a draining assignment must not deliver a duplicate stop command");
  assert.equal(assignments.acknowledge(PACKAGER, status("stopped", "STOP_COMPLETE"), NOW + 3).state, "stopped");
  assert.equal(assignments.activeForProgram(request().programId), null);
});

test("only the fenced output-ready status exposes an internal resource binding", () => {
  const assignments = registry();
  const admission = admitNativePackager(capability(), request(), NOW);
  assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);
  const status = (state, reasonCode) => ({
    version: 1, type: "assignment-status", assignmentId: "asn_aaaaaaaaaaaaaaaa",
    programEpoch: 7, fencingRevision: 9, state, reasonCode, observedAt: NOW + 1,
  });
  assignments.acknowledge(PACKAGER, status("ready", "CAPABILITY_READY"), NOW + 1);
  assignments.acknowledge(PACKAGER, status("starting", "MEDIA_STARTING"), NOW + 1);
  assert.throws(() => assignments.readyOutput(PACKAGER, status("running", "OUTPUT_READY"), NOW + 1), /stale/);
  assignments.acknowledge(PACKAGER, status("running", "OUTPUT_READY"), NOW + 1);
  assert.deepEqual(assignments.readyOutput(PACKAGER, status("running", "OUTPUT_READY"), NOW + 1), {
    resourceRef: "res_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa",
    packagerId: PACKAGER, fencingRevision: 9,
  });
  assert.equal(assignments.statusTarget(PACKAGER, status("running", "OUTPUT_READY"), NOW + 1).publisherPeerId, PUBLISHER);
  const restarting = status("degraded", "SOURCE_PROGRAM_RESTARTING");
  assert.throws(() => assignments.unavailableOutput(PACKAGER, restarting, NOW + 1), /stale/);
  assignments.acknowledge(PACKAGER, restarting, NOW + 1);
  const expected = { resourceRef: "res_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa",
    packagerId: PACKAGER, fencingRevision: 9 };
  assert.deepEqual(assignments.unavailableOutput(PACKAGER, restarting, NOW + 1), expected);
  assert.throws(() => assignments.readyOutput(PACKAGER, status("running", "OUTPUT_READY"), NOW + 1), /stale/);
  for (const [holder, message, now] of [
    ["pkr_bbbbbbbbbbbbbbbb", restarting, NOW + 1],
    [PACKAGER, { ...restarting, fencingRevision: 10 }, NOW + 1],
    [PACKAGER, { ...restarting, programEpoch: 8 }, NOW + 1],
    [PACKAGER, { ...restarting, reasonCode: "THERMAL_PRESSURE" }, NOW + 1],
    [PACKAGER, restarting, NOW + 60_000],
  ]) assert.throws(() => assignments.unavailableOutput(holder, message, now), /stale/);
  assignments.acknowledge(PACKAGER, status("running", "OUTPUT_READY"), NOW + 2);
  assert.deepEqual(assignments.readyOutput(PACKAGER, status("running", "OUTPUT_READY"), NOW + 2), expected);
  assert.throws(() => assignments.unavailableOutput(PACKAGER, restarting, NOW + 2), /stale/);
  const expiredFailure = { ...status("failed", "LEASE_EXPIRED"), observedAt: NOW + 60_000 };
  assignments.acknowledge(PACKAGER, expiredFailure, NOW + 60_000);
  assert.equal(assignments.unavailableOutput(PACKAGER, expiredFailure, NOW + 60_000), null);
  assert.equal(assignments.statusTarget(PACKAGER, expiredFailure, NOW + 60_000).assignment.state, "failed");
  assert.throws(() => assignments.unavailableOutput("pkr_bbbbbbbbbbbbbbbb", expiredFailure, NOW + 60_000), /stale/);
});

test("authenticated packager heartbeats renew only the current fenced assignment", () => {
  const assignments = registry();
  const admission = admitNativePackager(capability(), request(), NOW);
  assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000,
  }, PUBLISHER, NOW);
  const renewed = assignments.renew(PACKAGER, NOW + 30_000);
  assert.equal(renewed.snapshot.expiresAt, NOW + 90_000);
  assert.deepEqual(renewed.command, {
    version: 1, type: "assignment-renew", assignmentId: "asn_aaaaaaaaaaaaaaaa",
    programEpoch: 7, fencingRevision: 9, expiresAt: NOW + 90_000,
  });
  assert.equal(renewed.resourceRef, "res_aaaaaaaaaaaaaaaa");
  assert.throws(() => assignments.renew("invalid", NOW), /invalid_native_packager_assignment_renewal/);
  assert.equal(assignments.renew(PACKAGER, NOW + 90_001), null);
});

test("offline, self-expanded admission, disconnect and lease expiry fail closed", () => {
  assert.throws(() => registry({ id: PACKAGER, online: false, capability: capability() })
    .admit(OWNER, PACKAGER, request(), NOW), /native_packager_offline/);

  const assignments = registry();
  const admission = admitNativePackager(capability(), request(), NOW);
  assert.throws(() => assignments.prepare(OWNER, PACKAGER, {
    ...admission,
    renditions: [...admission.renditions, { ...admission.renditions[0], id: "invented" }],
  }, { leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 60_000 }, PUBLISHER, NOW),
  /invalid_native_packager_request|native_packager_admission_mismatch/);

  assignments.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 9, expiresAt: NOW + 1_000,
  }, PUBLISHER, NOW);
  assert.equal(assignments.activeForPackager(PACKAGER)?.assignmentId, "asn_aaaaaaaaaaaaaaaa");
  assert.equal(assignments.failPackager(PACKAGER).state, "failed");
  assert.equal(assignments.activeForPackager(PACKAGER), null);

  const expiring = registry();
  expiring.prepare(OWNER, PACKAGER, admission, {
    leaseId: "lea_bbbbbbbbbbbbbbbb", fencingRevision: 10, expiresAt: NOW + 1_000,
  }, PUBLISHER, NOW);
  const expired = [];
  expiring.prune(NOW + 1_001, (owner, assignment, command) => expired.push({ owner, assignment, command }));
  assert.equal(expired[0].owner, OWNER);
  assert.equal(expired[0].assignment.assignmentId, "asn_aaaaaaaaaaaaaaaa");
  assert.equal(expired[0].assignment.state, "draining");
  assert.equal(expired[0].command.reasonCode, "LEASE_EXPIRED");
  assert.equal(expiring.list(OWNER)[0].reasonCode, "LEASE_EXPIRED");
  expiring.prune(NOW + 31_002);
  assert.equal(expiring.activeForPackager(PACKAGER), null);
  assert.equal(expiring.list(OWNER)[0].state, "failed");
});
