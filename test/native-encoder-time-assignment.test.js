import assert from "node:assert/strict";
import test from "node:test";
import { NativePackagerAssignmentRegistry } from "../src/native-packager-assignment.js";
import { admitNativePackager } from "../src/native-packager-policy.js";
import { createAppServer } from "../src/server.js";
import { NATIVE_ENCODER_MINUTES_ENV } from "../src/native-encoder-time-budget.js";

const NOW = 1800000000000, OWNER = "https://id.example|owner", PEER = "0123456789abcdef";
const FIRST = "pkr_aaaaaaaaaaaaaaaa", SECOND = "pkr_bbbbbbbbbbbbbbbb", PROGRAM = "prg_aaaaaaaaaaaaaaaa";
function fixture(limits = { deployment: 1 }, source = false, extra = {}) {
  let ids = 0, until = Number.MAX_SAFE_INTEGER;
  const generation = Object.freeze({});
  const candidate = (owner, id, now = NOW) => {
    assert.equal(owner, OWNER);
    return { id, online: true, generation, capability: {
      capabilityVersion: source ? 2 : 1, ...(source ? { sourcePrograms: true } : {}), agentId: id,
      tenantId: "tn_aaaaaaaaaaaaaaaa", ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa",
      agentVersion: "1.0.0", ffmpegVersion: "6.1.1", videoEncoders: ["libx264"], audioEncoders: ["aac"],
      hardwareClass: "large", cpuClass: "high", gpuClass: "none", uploadClass: "over-15mbit", energyClass: "ac",
      health: "healthy", maximumRenditions: 3, maximumPixelsPerSecond: 1920 * 1080 * 60,
      consentedRoomIds: ["room-alpha"], observedAt: now, expiresAt: now + 60000,
    } };
  };
  const assignments = new NativePackagerAssignmentRegistry({ encoderMinutesLimits: limits,
    controlRegistry: { candidate, sourceContext: (owner, id, _room, now) => candidate(owner, id, now) },
    idFactory: () => `asn_${String(++ids).padStart(16, "0")}`,
    sourceProgramMembership: () => 1,
    programLeaseDeadline: () => until,
    iceServersForPackager: () => [{ urls: ["stun:synthetic.example"] }], ...extra });
  const request = (id = FIRST, program = PROGRAM, slots = 1) => ({ requestVersion: 1, trigger: "user-action",
    tenantId: "tn_aaaaaaaaaaaaaaaa", ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", roomId: "room-alpha",
    programId: program, programEpoch: 1, resourceRef: `res_${id.slice(4)}`, requestedRenditions: slots, allowHardwareAcceleration: false });
  const prepare = (id = FIRST, program = PROGRAM, now = NOW, duration = 60000, slots = 1) => {
    const admission = admitNativePackager(candidate(OWNER, id, now).capability, request(id, program, slots), now);
    return (source ? assignments.prepareSourceProgram.bind(assignments) : assignments.prepare.bind(assignments))(
      OWNER, id, admission, { leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 2, expiresAt: now + duration }, PEER, now);
  };
  const stop = (record, now = NOW) => {
    const r = record.snapshot; assignments.stop(OWNER, r.packagerId, r.assignmentId, "OWNER_STOP", now);
    assignments.acknowledge(r.packagerId, { version: 1, type: "assignment-status", assignmentId: r.assignmentId,
      programEpoch: r.programEpoch, fencingRevision: r.fencingRevision, state: "stopped", reasonCode: "STOPPED", observedAt: now }, now);
  };
  return { assignments, prepare, request, stop, candidate, idCount: () => ids, deadline: value => { until = value; } };
}

for (const [scope, name] of Object.entries(NATIVE_ENCODER_MINUTES_ENV)) test(`actual server composition enforces ${scope} encoder-time ENV`, async t => {
  const f = fixture();
  const app = createAppServer({ env: { AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false", [name]: "0" },
    nativePackagers: { candidate: f.candidate } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  assert.throws(() => app.nativePackagerAssignments.admit(OWNER, FIRST, f.request(), NOW), /broadcast_temporarily_unavailable/);
  assert.equal(app.nativePackagerAssignments.activeForPackager(FIRST), null);
  assert.equal(app.registry.roomCount, 0);
});

for (const source of [false, true]) for (const scope of ["deployment", "tenant", "principal"]) {
  test(`${scope} time is retained across stop and handoff preview, source=${source}`, () => {
    const f = fixture({ deployment: 100, tenant: 100, principal: 100, [scope]: 1 }, source);
    for (let i = 0; i < 5; i++) f.assignments.admit(OWNER, FIRST, f.request(), NOW);
    assert.equal(f.assignments.encoderTimeCounts(NOW).authorizedEncoderMilliseconds, 0);
    const first = f.prepare(); assert.equal(f.idCount(), 1);
    assert.equal(f.assignments.renew(FIRST, NOW + 1000), null);
    assert.equal(f.assignments.activeForPackager(FIRST).expiresAt, NOW + 60000);
    f.stop(first, NOW + 1000);
    assert.throws(() => f.assignments.previewReplacement(OWNER, SECOND,
      { ...f.request(SECOND), programEpoch: 2 }, first.snapshot.assignmentId, PEER, NOW + 1000), /broadcast_temporarily_unavailable/);
    assert.throws(() => f.prepare(SECOND, "prg_bbbbbbbbbbbbbbbb", NOW + 1000), /broadcast_temporarily_unavailable/);
    assert.equal(f.idCount(), 1, "time denial precedes ID/ICE allocation");
    assert.equal(f.assignments.encoderTimeCounts(NOW + 1000).authorizedEncoderMilliseconds, 60000);
    assert.doesNotThrow(() => f.prepare(SECOND, "prg_bbbbbbbbbbbbbbbb", NOW + 3600000));
  });
}

test("renewal pays only new time, even when a shorter program deadline temporarily reduces the public lease", () => {
  const f = fixture({ deployment: 2 }); f.prepare(FIRST, PROGRAM, NOW, 120000);
  for (let i = 0; i < 10; i++) assert.equal(f.assignments.renew(FIRST, NOW + 10000).snapshot.expiresAt, NOW + 70000);
  assert.equal(f.assignments.encoderTimeCounts(NOW + 10000).authorizedEncoderMilliseconds, 120000);
  f.deadline(NOW + 65000);
  assert.equal(f.assignments.renew(FIRST, NOW + 11000).snapshot.expiresAt, NOW + 65000);
  f.deadline(Number.MAX_SAFE_INTEGER);
  assert.equal(f.assignments.renew(FIRST, NOW + 60000).snapshot.expiresAt, NOW + 120000);
  assert.equal(f.assignments.renew(FIRST, NOW + 60001), null);
  assert.equal(f.assignments.encoderTimeCounts(NOW + 60001).authorizedEncoderMilliseconds, 120000);
});

test("multiple renditions consume weighted time and repeated heartbeat does not duplicate extensions", () => {
  const f = fixture({ deployment: 4 }); f.prepare(FIRST, PROGRAM, NOW, 60000, 3);
  for (let i = 0; i < 20; i++) assert.equal(f.assignments.renew(FIRST, NOW + 20000).snapshot.expiresAt, NOW + 80000);
  assert.equal(f.assignments.encoderTimeCounts(NOW + 20000).authorizedEncoderMilliseconds, 240000);
  assert.equal(f.assignments.renew(FIRST, NOW + 20001), null);
  assert.equal(f.assignments.activeForPackager(FIRST).expiresAt, NOW + 80000);
  const expired = []; f.assignments.prune(NOW + 80000, (...args) => expired.push(args));
  assert.equal(expired.length, 1); assert.equal(expired[0][2].type, "assignment-stop");
  assert.equal(expired[0][2].reasonCode, "LEASE_EXPIRED");
  assert.equal(f.assignments.renew(FIRST, NOW + 80000), null);
});

test("failed control delivery cannot refund the encoder lease", () => {
  const f = fixture(); f.prepare(); f.assignments.failPackager(FIRST, "CONTROL_DISCONNECTED", NOW + 1);
  f.assignments.prune(NOW + 61000);
  assert.throws(() => f.prepare(SECOND, "prg_bbbbbbbbbbbbbbbb", NOW + 61000), /broadcast_temporarily_unavailable/);
  assert.equal(f.assignments.encoderTimeCounts(NOW + 61000).authorizedEncoderMilliseconds, 60000);
});

for (const samePackager of [false, true]) test(`reentrant preparation rechecks time and writer ownership, same=${samePackager}`, () => {
  let nested = false, inner;
  const f = fixture({ deployment: samePackager ? 3 : 1 }, false, { iceServersForPackager: () => {
    if (!nested) { nested = true; inner = f.prepare(samePackager ? FIRST : SECOND, "prg_bbbbbbbbbbbbbbbb"); }
    return [{ urls: ["stun:synthetic.example"] }];
  } });
  assert.throws(() => f.prepare(), samePackager ? /native_packager_assignment_conflict/ : /broadcast_temporarily_unavailable/);
  assert.equal(f.assignments.activeForPackager(inner.snapshot.packagerId).assignmentId, inner.snapshot.assignmentId);
  assert.equal(f.assignments.activeForProgram(PROGRAM), null);
  assert.equal(f.assignments.encoderTimeCounts(NOW).authorizedEncoderMilliseconds, 60000);
});

test("reentrant renewal cannot overwrite a newer paid-until fence", () => {
  let nested = false, enabled = false, inner;
  const f = fixture({ deployment: 3 }, false, { programLeaseDeadline: () => {
    if (enabled && !nested) { nested = true; inner = f.assignments.renew(FIRST, NOW + 20000); }
    return Number.MAX_SAFE_INTEGER;
  } });
  f.prepare(); enabled = true;
  assert.equal(f.assignments.renew(FIRST, NOW + 10000), null);
  assert.equal(inner.snapshot.expiresAt, NOW + 80000);
  assert.equal(f.assignments.activeForPackager(FIRST).expiresAt, NOW + 80000);
  assert.equal(f.assignments.encoderTimeCounts(NOW + 20000).authorizedEncoderMilliseconds, 80000);
});

test("rollback prevents renewal and neither changes the lease nor exposes accounting internals on the wire", () => {
  const f = fixture(), first = f.prepare();
  assert.doesNotMatch(JSON.stringify(first), /encoderBudgetUntil|ownerPrincipal|encoderMinutes/);
  assert.equal(f.assignments.renew(FIRST, NOW - 1), null);
  assert.equal(f.assignments.renew(FIRST, NOW + 1), null);
  assert.equal(f.assignments.activeForPackager(FIRST).expiresAt, first.snapshot.expiresAt);
});
