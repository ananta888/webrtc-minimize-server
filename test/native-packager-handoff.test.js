import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { NativePackagerAssignmentRegistry } from "../src/native-packager-assignment.js";
import { handoffNativePackager } from "../src/native-packager-handoff.js";
import { broadcastSubjectRef, broadcastTenantRef } from "../src/broadcast-identifiers.js";

const FIRST = "pkr_aaaaaaaaaaaaaaaa", SECOND = "pkr_bbbbbbbbbbbbbbbb";
const NOW = 1_800_000_000_000;

function fixture(sourceProgram = false, audioOutput = null, videoOutput = null, maxProgramRuntimeMs = undefined, resourceLimits = undefined, programSlots = 1) {
  let now = NOW;
  let resourceSequence = 0, forcedResource = null;
  const identity = { issuer: "https://identity.example/realms/ananta", subject: "owner", displayName: "Owner" };
  const ownerPrincipal = `${identity.issuer}|${identity.subject}`;
  let member = { principal: ownerPrincipal, roomId: "room-alpha", creator: true,
    deviceFingerprint: "a".repeat(43), id: "0123456789abcdef" };
  const revoked = [], sent = [], unavailableDelivery = new Set();
  const runtime = new BroadcastRuntimeRegistry({ clock: () => now,
    maxProgramRuntimeMs,
    programCapacityLimits: { deployment: programSlots, gateway: programSlots, tenant: programSlots, principal: programSlots },
    resourceIdFactory: () => forcedResource || `res_${String(++resourceSequence).padStart(16, "0")}`, grantAuthority: {
    issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch(...args) { revoked.push(args); },
  } });
  const capabilities = new Map([FIRST, SECOND].map(agentId => [agentId, {
    capabilityVersion: sourceProgram ? 2 : 1, ...(sourceProgram ? { sourcePrograms: true } : {}),
    agentId, tenantId: broadcastTenantRef(identity.issuer), ownerSubjectRef: broadcastSubjectRef(identity),
    deviceRef: `dev_${agentId.slice(4)}`, agentVersion: "0.7.0", ffmpegVersion: "6.1.1",
    videoEncoders: ["libx264"], audioEncoders: ["aac"], hardwareClass: "medium", cpuClass: "medium",
    gpuClass: "none", uploadClass: "5-15mbit", energyClass: "ac", health: "healthy", maximumRenditions: 2,
    maximumPixelsPerSecond: 1280 * 720 * 30, consentedRoomIds: [member.roomId], observedAt: NOW, expiresAt: NOW + 30_000,
  }]));
  const generations = new Map([FIRST, SECOND].map(id => [id, Object.freeze({})]));
  if (audioOutput) for (const capability of capabilities.values()) Object.assign(capability,
    { capabilityVersion: 5, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1 });
  const assignments = new NativePackagerAssignmentRegistry({ resourceLimits, controlRegistry: {
    candidate(owner, id) {
      assert.equal(owner, ownerPrincipal);
      return { id, online: capabilities.has(id), capability: capabilities.get(id) };
    },
    sourceContext(owner, id) { assert.equal(owner, ownerPrincipal);
      return { id, online: capabilities.has(id), capability: capabilities.get(id), generation: generations.get(id) }; },
  }, programLeaseDeadline: (scope, at) => runtime.programLeaseDeadline(scope, at),
    sourceProgramMembership: (owner, room, id) => member?.id === id && member?.principal === owner
    && member?.roomId === room && member?.creator === true ? 1 : 0,
    iceServersForPackager: () => [{ urls: ["stun:stun.example:3478"] }] });
  const created = runtime.createProgram(identity, member, { requestVersion: 1, roomId: member.roomId,
    title: "Stable program", visibility: "private" }, now);
  const programId = created.control.programId;
  const sourceIds = ["src_aaaaaaaaaaaaaaaa"];
  const prepareProgram = sourceProgram ? runtime.prepareNativeSourceProgram.bind(runtime) : runtime.prepareNativePublisher.bind(runtime);
  const prepared = prepareProgram(identity, member, programId, { requestVersion: videoOutput ? 3 : audioOutput ? 2 : 1,
    ...(videoOutput ? { videoOutput, audioOutput } : audioOutput ? { audioOutput } : {}),
    trigger: "user-action", packagerId: FIRST, ...(sourceProgram ? { inputMode: "trusted-sframe-v1" } : { sourceIds }),
    requestedRenditions: 2, allowHardwareAcceleration: false,
  }, request => assignments.admit(ownerPrincipal, FIRST, request, now), now);
  const prepareAssignment = sourceProgram ? assignments.prepareSourceProgram.bind(assignments) : assignments.prepare.bind(assignments);
  const first = prepareAssignment(ownerPrincipal, FIRST, prepared.admission, prepared.lease, member.id, now);
  function status(assignment, state, reasonCode) {
    assignments.acknowledge(assignment.packagerId, { version: 1, type: "assignment-status",
      assignmentId: assignment.assignmentId, programEpoch: assignment.programEpoch,
      fencingRevision: assignment.fencingRevision, state, reasonCode, observedAt: now }, now);
  }
  for (const [state, reason] of [["ready", "CAPABILITY_READY"], ["starting", "INGRESS_STARTING"], ["running", "OUTPUT_READY"]]) {
    status(first.snapshot, state, reason);
  }
  runtime.markNativeOutputReady(prepared.admission.resourceRef, FIRST, prepared.lease.fencingRevision, now);
  const control = runtime.nativeControl(identity, member, programId);
  const input = { requestVersion: 1, trigger: "user-action", packagerId: SECOND,
    expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch,
    expectedFencingRevision: control.writer.fencingRevision, requestedRenditions: 2, allowHardwareAcceleration: false };
  const abort = new AbortController();
  const args = { runtime, assignments, identity, ownerPrincipal, programId, input, getMember: () => member,
    signal: abort.signal, clock: () => now, send(id, message) { sent.push({ id, message }); return !unavailableDelivery.has(id); } };
  return { runtime, assignments, identity, ownerPrincipal, programId, first, prepared, input, args, abort,
    sent, revoked, capabilities, status, unavailableDelivery, setMember: value => { member = value; }, member,
    setNow: value => { now = value; }, setResource: value => { forcedResource = value; } };
}

function standbyRequest(control, standbyPackagerIds = [SECOND]) {
  return { requestVersion: 1, trigger: "user-action", expectedProgramRevision: control.programRevision,
    expectedProgramEpoch: control.programEpoch, expectedStandbyRevision: control.standbyRevision,
    standbyPackagerIds, requestedRenditions: 2, allowHardwareAcceleration: false };
}

function replacementRequest(f, patch = {}) {
  return { requestVersion: 1, trigger: "user-action", tenantId: broadcastTenantRef(f.identity.issuer),
    ownerSubjectRef: broadcastSubjectRef(f.identity), roomId: f.member.roomId, programId: f.programId,
    programEpoch: f.first.snapshot.programEpoch + 1, resourceRef: "res_zzzzzzzzzzzzzzzz",
    requestedRenditions: 2, allowHardwareAcceleration: false, ...patch };
}

for (const source of [false, true]) test(`replacement preview is scoped metadata, never prepare permission, source=${source}`, () => {
  const f = fixture(source, null, null, undefined, { encoderSlots: 2 });
  const preview = (request = replacementRequest(f), id = f.first.snapshot.assignmentId, owner = f.ownerPrincipal, peer = f.member.id) =>
    f.assignments.previewReplacement(owner, SECOND, request, id, peer, NOW);
  const admitted = preview();
  assert.equal(admitted.agentId, SECOND);
  assert.equal(f.assignments.list(f.ownerPrincipal).length, 1);
  for (const patch of [{ programId: "prg_zzzzzzzzzzzzzzzz" }, { roomId: "other-room" },
    { tenantId: "tn_zzzzzzzzzzzzzzzz" }, { ownerSubjectRef: "sub_zzzzzzzzzzzzzzzz" },
    { programEpoch: 0 }, { programEpoch: f.first.snapshot.programEpoch + 2 }]) {
    assert.throws(() => preview(replacementRequest(f, patch)));
  }
  assert.throws(() => preview(undefined, "asn_zzzzzzzzzzzzzzzz"), /stale_native_packager_replacement/);
  assert.throws(() => preview(undefined, undefined, "foreign"), /stale_native_packager_replacement/);
  assert.throws(() => preview(undefined, undefined, undefined, "fedcba9876543210"), /stale_native_packager_replacement/);
  assert.throws(() => f.assignments.previewReplacement(f.ownerPrincipal, FIRST, replacementRequest(f),
    f.first.snapshot.assignmentId, f.member.id, NOW), /stale_native_packager_replacement/);
  const prepare = source ? f.assignments.prepareSourceProgram.bind(f.assignments) : f.assignments.prepare.bind(f.assignments);
  assert.throws(() => prepare(f.ownerPrincipal, SECOND, admitted, f.prepared.lease, f.member.id, NOW));
  const standby = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
  f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(standby),
    (_id, request) => preview(request), NOW);
  assert.equal(f.assignments.activeForPackager(SECOND), null);
  assert.deepEqual(f.sent, []);
  f.assignments.failPackager(FIRST, "CONTROL_DISCONNECTED", NOW);
  assert.throws(() => preview(), /stale_native_packager_replacement/);
});

test("another program can consume released capacity while a handoff waits, but cannot be evicted", async () => {
  const f = fixture(false, null, null, undefined, { encoderSlots: 2 }, 2);
  const transfer = handoffNativePackager(f.args);
  const rejected = assert.rejects(transfer, /broadcast_temporarily_unavailable/);
  f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
  const otherId = f.runtime.createProgram(f.identity, f.member, {
    requestVersion: 1, roomId: f.member.roomId, title: "Independent program", visibility: "private",
  }, NOW).control.programId;
  const other = f.runtime.prepareNativePublisher(f.identity, f.member, otherId, {
    requestVersion: 1, trigger: "user-action", packagerId: FIRST, sourceIds: ["src_aaaaaaaaaaaaaaaa"],
    requestedRenditions: 2, allowHardwareAcceleration: false,
  }, request => f.assignments.admit(f.ownerPrincipal, FIRST, request, NOW), NOW);
  const occupied = f.assignments.prepare(f.ownerPrincipal, FIRST, other.admission, other.lease, f.member.id, NOW);
  await rejected;
  assert.equal(f.assignments.activeForPackager(FIRST).assignmentId, occupied.snapshot.assignmentId);
  assert.equal(f.assignments.activeForPackager(SECOND), null);
  assert.equal(f.sent.length, 1);
  assert.equal(f.runtime.listMine(f.identity).owned.find(program => program.programId === f.programId).availability, "ended");
});

const monoOutput = Object.freeze({ codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 });
for (const [source, audio, video] of [[false, null, null], [true, null, null], [true, monoOutput, null],
  [true, monoOutput, { profile: "screen-v1" }]]) {
  test(`serial handoff fits a single writer budget for source=${source} audio=${!!audio} video=${!!video}`, async () => {
    const f = fixture(source, audio, video, undefined, { encoderSlots: 2 });
    const transfer = handoffNativePackager(f.args);
    // Attach rejection observation before yielding, including the pre-fix failure.
    const result = transfer.then(value => ({ value }), error => ({ error }));
    assert.equal(f.assignments.activeForPackager(SECOND), null);
    assert.equal(f.sent.length, 1, "preflight must allow a serial replacement and send only the original stop");
    assert.equal(f.sent[0].message.type, "assignment-stop");
    f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
    const settled = await result;
    assert.equal(settled.error, undefined);
    assert.equal(settled.value.assignment.packagerId, SECOND);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].message.type, "assignment-prepare");
    assert.equal(f.sent[1].message.version, source ? (audio ? 5 : 4) : 3);
    assert.equal(f.assignments.activeForPackager(FIRST), null);
  });
}
for (const sourceProgram of [false, true]) test(`absolute runtime survives ${sourceProgram ? "source" : "legacy"} writer handoff and real lease renewal`, async () => {
  const f = fixture(sourceProgram, null, null, 60_000);
  f.setNow(NOW + 20_000);
  const transfer = handoffNativePackager(f.args);
  f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED"); await transfer;
  const next = f.assignments.activeForProgram(f.programId);
  assert.equal(f.sent[1].message.expiresAt, NOW + 60_000);
  assert.equal(next.expiresAt, NOW + 60_000);
  const renewal = f.assignments.renew(SECOND, NOW + 25_000);
  assert.equal(renewal.command.expiresAt, NOW + 60_000);
  assert.equal(renewal.snapshot.expiresAt, NOW + 60_000);
  f.setNow(NOW + 60_000); f.runtime.prune();
  assert.equal(f.runtime.nativeControl(f.identity, f.member, f.programId).state, "stopped");
  assert.equal(f.assignments.renew(SECOND, NOW + 60_000), null);
  assert.throws(() => f.runtime.completeNativeHandoff(f.identity, f.member, {}, () => assert.fail(), NOW + 60_000));
});
for (const audioOutput of [null, monoOutput]) test("selected video survives standby and real stop-ACK handoff without client override", async () => {
  const videoOutput = { profile: "screen-v1" }, f = fixture(true, audioOutput, videoOutput);
  videoOutput.profile = "economy-v1";
  const control = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
  f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(control), (id, request) => {
    assert.equal(request.requestVersion, 3); assert.deepEqual(request.videoOutput, { profile: "screen-v1" });
    assert.deepEqual(request.audioOutput, audioOutput);
    return f.assignments.admit(f.ownerPrincipal, id, request, NOW);
  }, NOW);
  await assert.rejects(handoffNativePackager({ ...f.args, input: { ...f.input, videoOutput: { profile: "economy-v1" } } }), /invalid_native_packager_handoff/);
  const task = handoffNativePackager(f.args);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message.type, "assignment-stop");
  f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
  await task;
  assert.deepEqual(f.sent[1].message.profile, f.first.command.profile);
  assert.equal(f.sent[1].message.version, audioOutput ? 5 : 4);
});
function downgradeAudio(f) {
  const capability = f.capabilities.get(SECOND);
  capability.capabilityVersion = 4; capability.sourceAudioControlVersion = 2; delete capability.sourceAudioEncodingVersion;
}

test("v5 standby and both handoff phases preserve server-owned output selection", async () => {
  const selected = { ...monoOutput }, f = fixture(true, selected);
  selected.channels = 2;
  const control = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
  const requests = [];
  f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(control), (id, request) => {
    requests.push(request); return f.assignments.admit(f.ownerPrincipal, id, request, NOW);
  }, NOW);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestVersion, 2);
  assert.deepEqual(requests[0].audioOutput, monoOutput);
  assert.ok(Object.isFrozen(requests[0].audioOutput));
  const task = handoffNativePackager(f.args);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message.type, "assignment-stop");
  f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
  const next = await task;
  const command = f.sent[1].message;
  assert.equal(command.version, 5); assert.deepEqual(command.audioOutput, monoOutput);
  assert.ok(command.profile.renditions.every(r => r.audioBitsPerSecond === 48000));
  assert.equal(next.assignment.inputMode, "trusted-sframe-v1");
  assert.notEqual(command.resourceRef, f.first.command.resourceRef);
});

test("v5 rejects unsupported standby/handoff before stopping the original writer", async () => {
  const f = fixture(true, monoOutput); downgradeAudio(f);
  const control = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
  assert.throws(() => f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(control),
    (id, request) => f.assignments.admit(f.ownerPrincipal, id, request, NOW), NOW), /native_source_audio_output_unsupported/);
  await assert.rejects(handoffNativePackager(f.args), /native_source_audio_output_unsupported/);
  assert.deepEqual(f.sent, []);
  assert.equal(f.assignments.activeForPackager(FIRST).state, "running");
  assert.equal(f.runtime.nativeControl(f.identity, f.member, f.programId).handoffPending, false);
});

test("v5 rechecks output support after drain and rejects client format mutation", async () => {
  const f = fixture(true, monoOutput);
  await assert.rejects(handoffNativePackager({ ...f.args, input: { ...f.input, audioOutput: { ...monoOutput, channels: 2 } } }), /invalid_native_packager_handoff/);
  assert.deepEqual(f.sent, []);
  const task = handoffNativePackager(f.args);
  const rejected = assert.rejects(task, /native_source_audio_output_unsupported/);
  downgradeAudio(f); f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
  await rejected;
  assert.equal(f.sent.length, 1, "no unsupported successor prepare after stop");
  assert.equal(f.assignments.activeForPackager(SECOND), null);
  assert.equal(f.runtime.listMine(f.identity).owned[0].availability, "ended");
});

test("standby selection is keyless, versioned metadata and never changes the live writer", () => {
  const f = fixture();
  const writer = f.runtime.nativeControl(f.identity, f.member, f.programId);
  const initial = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
  assert.deepEqual(initial.standbyPackagerIds, []);
  assert.equal(initial.standbyRevision, 0);
  const revokedBefore = f.revoked.length;
  const admit = (id, request) => f.assignments.admit(f.ownerPrincipal, id, request, NOW);
  const next = f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(initial), admit);
  assert.deepEqual(next.standbyPackagerIds, [SECOND]);
  assert.equal(next.standbyRevision, 1);
  assert.deepEqual(f.runtime.nativeControl(f.identity, f.member, f.programId), writer);
  assert.equal(f.assignments.activeForPackager(SECOND), null);
  assert.equal(f.sent.length, 0);
  assert.equal(f.revoked.length, revokedBefore);
  assert.throws(() => f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(initial), admit),
    /stale_native_standby_selection/);
  const cleared = f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(next, []), admit);
  assert.deepEqual(cleared.standbyPackagerIds, []);
  assert.equal(cleared.standbyRevision, 2);
});

test("standby selection validates all candidates atomically with fresh consent and owner-device scope", () => {
  const f = fixture();
  const initial = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
  const admit = (id, request) => f.assignments.admit(f.ownerPrincipal, id, request, NOW);
  const select = (input, identity = f.identity, member = f.member) =>
    f.runtime.selectNativeStandbys(identity, member, f.programId, input, admit);
  for (const bad of [
    { ...standbyRequest(initial), extra: true }, { ...standbyRequest(initial), trigger: "remote-signal" },
    standbyRequest(initial, [FIRST]), standbyRequest(initial, [SECOND, SECOND]),
    standbyRequest(initial, [SECOND, "pkr_cccccccccccccccc", "pkr_dddddddddddddddd"]),
  ]) assert.throws(() => select(bad), /invalid_native_standby_selection/);
  assert.throws(() => select(standbyRequest(initial), { ...f.identity, subject: "stranger" }), /broadcast_not_available/);
  for (const member of [null, { ...f.member, id: "fedcba9876543210" }, { ...f.member, creator: false },
    { ...f.member, deviceFingerprint: "b".repeat(43) }]) {
    assert.throws(() => select(standbyRequest(initial), f.identity, member), /broadcast_publisher_membership_required/);
  }
  f.capabilities.get(SECOND).consentedRoomIds = [];
  assert.throws(() => select(standbyRequest(initial)), /native_packager_room_consent_required/);
  f.capabilities.get(SECOND).consentedRoomIds = [f.member.roomId];
  assert.throws(() => select(standbyRequest(initial, [SECOND, "pkr_cccccccccccccccc"])), /native_packager_offline/);
  assert.deepEqual(f.runtime.nativeStandbyControl(f.identity, f.member, f.programId), initial);
  assert.equal(f.assignments.activeForPackager(SECOND), null);
});

test("stop and native handoff fence the whole previous standby plan", () => {
  for (const operation of ["stop", "handoff"]) {
    const f = fixture();
    const initial = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
    const admit = (id, request) => f.assignments.admit(f.ownerPrincipal, id, request, NOW);
    f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(initial), admit);
    if (operation === "stop") f.runtime.stopProgram(f.identity, f.programId);
    else f.runtime.beginNativeHandoff(f.identity, f.member, f.programId, f.input, request => admit(SECOND, request));
    const next = f.runtime.nativeStandbyControl(f.identity, f.member, f.programId);
    assert.deepEqual(next.standbyPackagerIds, []);
    assert.equal(next.standbyRevision, 0);
    assert.throws(() => f.runtime.selectNativeStandbys(f.identity, f.member, f.programId, standbyRequest(initial), admit),
      /stale_native_standby_selection/);
  }
});

for (const sourceProgram of [false, true]) test(`${sourceProgram ? "v4 source program" : "legacy publisher"} stop ACK fences one successor with a fresh output generation`, async () => {
  const f = fixture(sourceProgram);
  const before = f.runtime.listMine(f.identity).owned[0];
  const task = handoffNativePackager(f.args);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.type, "assignment-stop");
  assert.equal(f.assignments.activeForProgram(f.programId).state, "draining");
  assert.equal(f.assignments.activeForPackager(SECOND), null);
  assert.equal(f.runtime.nativeControl(f.identity, f.member, f.programId).handoffPending, true);
  assert.ok(f.revoked.some(([, program, epoch]) => program === f.programId && epoch === before.programEpoch));
  assert.throws(() => f.runtime.markNativeOutputReady(f.prepared.admission.resourceRef, FIRST,
    f.first.snapshot.fencingRevision, NOW), /broadcast_not_available/);
  await assert.rejects(handoffNativePackager(f.args), /stale_broadcast_handoff_writer/);
  await delay(35);
  assert.equal(f.sent.length, 1, "successor must not start before the old writer confirms stop");
  f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
  const next = await task;
  assert.equal(next.program.programId, f.programId);
  assert.equal(next.program.programEpoch, before.programEpoch + 1);
  assert.ok(next.assignment.fencingRevision > f.first.snapshot.fencingRevision);
  const command = f.sent[1].message;
  assert.equal(command.type, "assignment-prepare");
  assert.equal(command.version, sourceProgram ? 4 : 3);
  if (sourceProgram) {
    assert.equal(command.inputMode, "trusted-sframe-v1");
    assert.equal(command.sourceContext.granteeDeviceRef, f.capabilities.get(SECOND).deviceRef);
    assert.equal("publisherPeerId" in command, false);
  }
  assert.notEqual(command.resourceRef, f.prepared.admission.resourceRef);
  assert.equal(f.assignments.activeForPackager(FIRST), null);
  assert.equal(f.runtime.nativeControl(f.identity, f.member, f.programId).handoffPending, false);
  for (const [state, reason] of [["ready", "CAPABILITY_READY"], ["starting", "INGRESS_STARTING"], ["running", "OUTPUT_READY"]]) {
    f.status(next.assignment, state, reason);
  }
  const live = f.runtime.markNativeOutputReady(command.resourceRef, SECOND, next.assignment.fencingRevision, NOW);
  assert.equal(live.availability, "live");
  assert.equal(live.title, before.title);
  assert.equal(live.visibility, before.visibility);
  assert.equal(f.runtime.programCount, 1);
  assert.throws(() => f.assignments.authorizePackagerSignal(FIRST, {
    assignmentId: f.first.snapshot.assignmentId, programEpoch: f.first.snapshot.programEpoch,
    fencingRevision: f.first.snapshot.fencingRevision,
  }, NOW), /stale_native_packager_signal/);
});

test("source-program handoff rejects a target without opt-in before stopping the old writer", async () => {
  const f = fixture(true); f.capabilities.get(SECOND).sourcePrograms = false;
  await assert.rejects(handoffNativePackager(f.args), /native_source_program_unavailable/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.assignments.activeForPackager(FIRST).state, "running");
  assert.equal(f.assignments.activeForPackager(SECOND), null);
});

for (const reason of ["abort", "deadline", "disconnect", "membership", "consent", "delivery", "prepare-failure"]) {
  test(`handoff ${reason} cannot start a late successor`, async () => {
    const f = fixture();
    const task = handoffNativePackager(f.args);
    const rejected = assert.rejects(task);
    if (reason === "abort") f.abort.abort();
    if (reason === "deadline") f.setNow(NOW + 12_000);
    if (reason === "disconnect") f.assignments.failPackager(FIRST, "CONTROL_DISCONNECTED", NOW);
    if (reason === "membership") f.setMember({ ...f.member, id: "fedcba9876543210" });
    if (reason === "consent") f.capabilities.get(SECOND).consentedRoomIds = [];
    if (reason === "delivery") f.unavailableDelivery.add(SECOND);
    if (!["abort", "deadline", "disconnect"].includes(reason)) f.status(f.first.snapshot, "stopped", "ASSIGNMENT_STOPPED");
    if (reason === "prepare-failure") f.assignments.prepare = () => { throw new Error("prepare_failed"); };
    await rejected;
    assert.equal(f.assignments.activeForPackager(SECOND), null);
    assert.equal(f.runtime.listMine(f.identity).owned[0].availability, "ended");
    assert.equal(f.runtime.nativeControl(f.identity, f.member, f.programId).handoffPending, false);
  });
}

test("invalid owner/device, stale commands and target admission failures preserve the current live writer", async () => {
  for (const variant of ["owner", "device", "revision", "epoch", "fence", "unknown", "offline", "busy", "resource-reuse"]) {
    const f = fixture();
    const before = f.runtime.listMine(f.identity);
    const args = { ...f.args, input: { ...f.input } };
    if (variant === "owner") args.identity = { ...f.identity, subject: "foreign" };
    if (variant === "device") args.getMember = () => ({ ...f.member, deviceFingerprint: "b".repeat(43) });
    if (variant === "revision") args.input.expectedProgramRevision++;
    if (variant === "epoch") args.input.expectedProgramEpoch++;
    if (variant === "fence") args.input.expectedFencingRevision++;
    if (variant === "unknown") args.input.extra = true;
    if (variant === "offline") f.capabilities.delete(SECOND);
    if (variant === "busy") f.assignments.activeForPackager = () => ({});
    if (variant === "resource-reuse") f.setResource(f.prepared.admission.resourceRef);
    await assert.rejects(handoffNativePackager(args), undefined, variant);
    assert.deepEqual(f.runtime.listMine(f.identity), before, variant);
    assert.equal(f.sent.length, 0, variant);
  }
});

test("foreign handoff requests cannot enumerate assignment presence or writer state", async () => {
  const f = fixture();
  let assignmentReads = 0;
  f.assignments.activeForProgram = () => { assignmentReads++; return null; };
  for (const programId of [f.programId, "prg_zzzzzzzzzzzzzzzz"]) {
    await assert.rejects(handoffNativePackager({ ...f.args, programId,
      identity: { ...f.identity, subject: "foreign" } }), error => error.code === "broadcast_not_available" && error.status === 404);
  }
  assert.equal(assignmentReads, 0);
});

test("handoff continuation is internal, non-replayable and invalid after cancellation", () => {
  const f = fixture();
  const admit = request => f.assignments.admit(f.ownerPrincipal, SECOND, request, NOW);
  const pending = f.runtime.beginNativeHandoff(f.identity, f.member, f.programId, f.input, admit, NOW);
  assert.throws(() => f.runtime.completeNativeHandoff(f.identity, f.member, { ...pending }, admit, NOW), /stale_broadcast_handoff/);
  f.runtime.cancelNativeHandoff(f.identity, { ...pending }, NOW);
  assert.equal(f.runtime.nativeControl(f.identity, f.member, f.programId).handoffPending, true);
  f.runtime.cancelNativeHandoff(f.identity, pending, NOW);
  assert.throws(() => f.runtime.completeNativeHandoff(f.identity, f.member, pending, admit, NOW), /stale_broadcast_handoff/);
});

test("repeated handoffs reserve terminal cleanup instead of exhausting the command ledger mid-transfer", async () => {
  const f = fixture();
  let current = f.first.snapshot, rejected = false;
  for (let index = 0; index < 64; index++) {
    const control = f.runtime.nativeControl(f.identity, f.member, f.programId);
    const input = { ...f.input, packagerId: current.packagerId === FIRST ? SECOND : FIRST,
      expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch,
      expectedFencingRevision: control.writer.fencingRevision };
    const before = f.sent.length;
    const task = handoffNativePackager({ ...f.args, input });
    if (f.sent.length === before) {
      await assert.rejects(task, /broadcast_handoff_capacity_exhausted/);
      rejected = true;
      break;
    }
    f.status(current, "stopped", "ASSIGNMENT_STOPPED");
    const result = await task;
    current = result.assignment;
    for (const [state, reason] of [["ready", "CAPABILITY_READY"], ["starting", "INGRESS_STARTING"], ["running", "OUTPUT_READY"]]) {
      f.status(current, state, reason);
    }
    f.runtime.markNativeOutputReady(f.sent.at(-1).message.resourceRef, current.packagerId, current.fencingRevision, NOW);
  }
  assert.equal(rejected, true);
  assert.equal(f.assignments.activeForProgram(f.programId).state, "running");
  assert.equal(f.runtime.listMine(f.identity).owned[0].availability, "live");
  assert.equal(f.runtime.stopProgram(f.identity, f.programId, NOW).availability, "ended");
});
