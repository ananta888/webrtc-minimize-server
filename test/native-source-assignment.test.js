import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { NativePackagerAssignmentRegistry } from "../src/native-packager-assignment.js";

const NOW = 1_800_000_000_000, OWNER = "synthetic-owner", PEER = "0123456789abcdef";
const report = JSON.parse(fs.readFileSync(new URL("./fixtures/native-source-capability.v2.json", import.meta.url))).capability;
const schema = JSON.parse(fs.readFileSync(new URL("../contracts/native-packager/assignment-prepare.v4.schema.json", import.meta.url)));
const validate = new Ajv({ strict: true }).compile(schema);
function setup(audioOutput, videoOutput) {
  const state = { capability: structuredClone(report), generation: Object.freeze({}), epoch: 4, member: true, ice: [] };
  if (audioOutput) Object.assign(state.capability, { capabilityVersion: 5, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1 });
  const packager = report.agentId;
  const candidate = (owner, id) => {
    assert.equal(owner, OWNER); assert.equal(id, packager);
    return { id, online: true, capability: state.capability, generation: state.generation };
  };
  const registry = new NativePackagerAssignmentRegistry({ controlRegistry: { candidate,
    sourceContext: (owner, id, room) => { assert.equal(room, report.consentedRoomIds[0]); return candidate(owner, id); } },
    sourceProgramMembership: (owner, room, peer) => {
      assert.equal(owner, OWNER); assert.equal(room, report.consentedRoomIds[0]); assert.equal(peer, PEER);
      return state.member ? state.epoch : 0;
    }, iceServersForPackager: () => state.ice, idFactory: () => "asn_aaaaaaaaaaaaaaaa" });
  const request = { requestVersion: videoOutput ? 3 : audioOutput ? 2 : 1,
    ...(videoOutput ? { videoOutput, audioOutput: audioOutput ?? null } : audioOutput ? { audioOutput } : {}), trigger: "user-action", tenantId: report.tenantId,
    ownerSubjectRef: report.ownerSubjectRef, roomId: report.consentedRoomIds[0], programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 2, resourceRef: "res_aaaaaaaaaaaaaaaa", requestedRenditions: 1, allowHardwareAcceleration: false };
  const admission = registry.admit(OWNER, packager, request, NOW);
  const lease = { leaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 3, expiresAt: NOW + 60000 };
  const prepare = () => registry.prepareSourceProgram(OWNER, packager, admission, lease, PEER, NOW);
  const running = () => {
    const result = prepare();
    for (const state of ["ready", "starting", "running"]) registry.acknowledge(packager, {
      version: 1, type: "assignment-status", assignmentId: result.snapshot.assignmentId, programEpoch: 2,
      fencingRevision: 3, state, reasonCode: state === "running" ? "OUTPUT_READY" : "PREPARING", observedAt: NOW }, NOW);
    return result;
  };
  return { state, registry, packager, request, admission, lease, prepare, running };
}

for (const audio of [undefined, { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 }]) {
  test(`selected screen output is readmitted and projects to closed v${audio ? 5 : 4} wire`, () => {
    const f = setup(audio, { profile: "screen-v1" });
    const tampered = structuredClone(f.admission); tampered.videoOutput.profile = "economy-v1";
    assert.throws(() => f.registry.prepareSourceProgram(OWNER, f.packager, tampered, f.lease, PEER, NOW), /admission_mismatch/);
    assert.throws(() => f.registry.prepare(OWNER, f.packager, f.admission, f.lease, PEER, NOW), /invalid_native_packager_assignment/);
    const result = f.running();
    const schema = JSON.parse(fs.readFileSync(new URL(`../contracts/native-packager/assignment-prepare.v${audio ? 5 : 4}.schema.json`, import.meta.url)));
    const check = new Ajv({ strict: true }).compile(schema);
    assert.equal(check(result.command), true, JSON.stringify(check.errors));
    assert.equal("videoOutput" in result.command, false, "existing wire already carries exact encoder values");
    assert.equal(result.command.profile.renditions[0].framesPerSecond, 10);
    assert.equal(result.command.profile.renditions[0].videoBitsPerSecond, 400000);
    assert.equal(result.command.version, audio ? 5 : 4);
  });
}

test("explicit source program emits a closed v4 assignment without legacy publisher signaling", () => {
  const f = setup(), result = f.running();
  assert.equal(validate(result.command), true, JSON.stringify(validate.errors));
  assert.equal(result.command.version, 4); assert.equal(result.command.inputMode, "trusted-sframe-v1");
  assert.equal("publisherPeerId" in result.command, false);
  assert.equal("controllerPeerId" in result.command, false);
  assert.equal("sourceGeneration" in result.command, false);
  assert.deepEqual(result.command.sourceContext, { schema: "ananta.trusted-source-program-context.v1",
    tenantId: report.tenantId, roomEpoch: 4, granteeDeviceRef: report.deviceRef, frameEnvelope: "codec-prefix-v1" });
  assert.ok(Object.isFrozen(result.command.sourceContext));
  assert.deepEqual(result.command.iceServers, []);
  const signal = { ...result.snapshot, packagerId: f.packager };
  assert.throws(() => f.registry.authorizeBrowserSignal({ id: PEER, principal: OWNER, roomId: f.request.roomId }, signal, NOW), /stale_native_packager_signal/);
  assert.throws(() => f.registry.authorizePackagerSignal(f.packager, signal, NOW), /stale_native_packager_signal/);
  assert.equal(f.registry.statusTarget(f.packager, signal, NOW).publisherPeerId, PEER, "controller receives metadata only");
  assert.equal(f.registry.sourceContext(f.packager, NOW).leaseId, f.lease.leaseId);
  assert.equal(f.registry.renew(f.packager, NOW + 1000).command.expiresAt, NOW + 61000);
  assert.throws(f.prepare, /native_packager_assignment_conflict/);
});

test("explicit output emits immutable v5, forbids legacy signaling and fences capability downgrade", () => {
  const selected = { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 };
  const f = setup(selected), result = f.running();
  const v5 = new Ajv({ strict: true }).compile(JSON.parse(fs.readFileSync(new URL("../contracts/native-packager/assignment-prepare.v5.schema.json", import.meta.url))));
  assert.equal(v5(result.command), true, JSON.stringify(v5.errors));
  assert.equal(validate(result.command), false);
  assert.deepEqual(result.command.audioOutput, selected);
  assert.ok(Object.isFrozen(result.command.audioOutput));
  selected.channels = 2;
  assert.equal(result.command.audioOutput.channels, 1, "caller cannot mutate the owned selection");
  assert.equal(result.snapshot.inputMode, "trusted-sframe-v1");
  const signal = { ...result.snapshot, packagerId: f.packager };
  assert.throws(() => f.registry.authorizeBrowserSignal({ id: PEER, principal: OWNER, roomId: f.request.roomId }, signal, NOW), /stale_native_packager_signal/);
  assert.throws(() => f.registry.authorizePackagerSignal(f.packager, signal, NOW), /stale_native_packager_signal/);
  assert.equal(f.registry.sourceContext(f.packager, NOW).leaseId, f.lease.leaseId);
  f.state.capability.capabilityVersion = 4;
  f.state.capability.sourceAudioControlVersion = 2;
  delete f.state.capability.sourceAudioEncodingVersion;
  assert.equal(f.registry.sourceContext(f.packager, NOW), null);
  assert.throws(() => f.registry.renew(f.packager, NOW + 1000));
});

test("v5 cannot enter legacy prepare or survive output mutation between admission and prepare", () => {
  const selected = { codec: "aac", sampleRate: 48000, channels: 2, targetBitsPerSecond: 192000 };
  const f = setup(selected);
  assert.throws(() => f.registry.prepare(OWNER, f.packager, f.admission, f.lease, PEER, NOW), /invalid_native_packager_assignment/);
  const changed = structuredClone(f.admission); changed.audioOutput.targetBitsPerSecond = 96000;
  assert.throws(() => f.registry.prepareSourceProgram(OWNER, f.packager, changed, f.lease, PEER, NOW), /native_packager_admission_mismatch/);
  assert.equal(f.registry.activeForPackager(f.packager), null);
});

test("capability opt-in never upgrades an explicit legacy publisher request", () => {
  const f = setup(); f.state.ice = [{ urls: ["stun:stun.example.test:3478"] }];
  const result = f.registry.prepare(OWNER, f.packager, f.admission, f.lease, PEER, NOW);
  assert.equal(result.command.version, 3); assert.equal(result.command.publisherPeerId, PEER);
  assert.equal("sourceContext" in result.command, false);
});

test("source preparation denies missing capability, membership and opaque lifecycle before reserving a writer", () => {
  for (const mutate of [
    f => { f.state.capability.sourcePrograms = false; },
    f => { f.state.capability.capabilityVersion = 1; delete f.state.capability.sourcePrograms; },
    f => { f.state.member = false; }, f => { f.state.epoch = 0; },
    f => { f.state.epoch = Number.MAX_SAFE_INTEGER + 1; }, f => { f.state.generation = {}; },
    f => { f.state.generation = null; },
  ]) {
    const f = setup(); mutate(f);
    assert.throws(f.prepare);
    assert.equal(f.registry.activeForProgram(f.request.programId), null);
    assert.equal(f.registry.activeForPackager(f.packager), null);
  }
});

test("epoch, controller, consent generation and device loss fence renewal and source parents", () => {
  for (const mutate of [
    f => { f.state.epoch++; }, f => { f.state.member = false; },
    f => { f.state.generation = Object.freeze({}); },
    f => { f.state.capability.sourcePrograms = false; },
    f => { f.state.capability.deviceRef = "dev_bbbbbbbbbbbbbbbb"; },
    f => { f.state.capability.consentedRoomIds = []; },
    f => { f.state.capability.expiresAt = NOW; },
    f => { f.state.capability.health = "unhealthy"; },
  ]) {
    const f = setup(); f.running(); mutate(f);
    const before = f.registry.activeForPackager(f.packager).expiresAt;
    assert.equal(f.registry.sourceContext(f.packager, NOW + 1000), null);
    assert.throws(() => f.registry.renew(f.packager, NOW + 1000));
    const status = { version: 1, type: "assignment-status", assignmentId: "asn_aaaaaaaaaaaaaaaa", programEpoch: 2,
      fencingRevision: 3, state: "running", reasonCode: "OUTPUT_READY", observedAt: NOW + 1000 };
    assert.throws(() => f.registry.acknowledge(f.packager, status, NOW + 1000));
    assert.throws(() => f.registry.readyOutput(f.packager, status, NOW + 1000));
    assert.equal(f.registry.activeForPackager(f.packager).expiresAt, before);
    assert.equal(f.registry.stop(OWNER, f.packager, "asn_aaaaaaaaaaaaaaaa", "OWNER_STOP", NOW + 1000).command.type, "assignment-stop");
    assert.equal(f.registry.acknowledge(f.packager, { ...status, state: "stopped", reasonCode: "ASSIGNMENT_STOPPED" }, NOW + 1000).state, "stopped");
  }
});

test("v4 ICE entries meet their closed homogeneous wire schema", () => {
  const valid = [{ urls: ["stun:stun.example.test:3478"] }, { urls: ["turns:turn.example.test:5349?transport=tcp"],
    username: "synthetic", credential: "synthetic-short-lived", credentialType: "password" }];
  const good = setup(); good.state.ice = valid;
  assert.equal(validate(good.prepare().command), true, JSON.stringify(validate.errors));
  for (const ice of [
    [{ ...valid[1], urls: [valid[0].urls[0], valid[1].urls[0]] }],
    [{ urls: ["STUN:stun.example.test:3478"] }],
    [{ urls: ["stun:stün.example.test:3478"] }],
    [{ urls: ["stun:stun.example.test:3478"], credential: "extra" }],
    [{ ...valid[1], extra: true }], [{ urls: [] }], Array(25).fill(valid[0]),
  ]) {
    const f = setup(); f.state.ice = ice;
    assert.throws(f.prepare, /invalid_native_packager_ice_configuration/);
    assert.equal(f.registry.activeForPackager(f.packager), null);
  }
});
