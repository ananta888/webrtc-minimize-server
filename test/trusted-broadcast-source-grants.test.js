import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import fs from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import WebSocket from "ws";
import { once } from "node:events";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { createAppServer } from "../src/server.js";
import { createOidcVerifier } from "../src/oidc-verifier.js";
import { RoomRegistry } from "../src/room-registry.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { BroadcastSourceRequests } from "../src/broadcast-source-requests.js";
import { NativePackagerControlRegistry, nativePackagerAuthMessage } from "../src/native-packager-control.js";
import { broadcastSubjectRef, broadcastTenantRef, oidcPrincipal } from "../src/broadcast-identifiers.js";
import { TrustedBroadcastSourceGrants } from "../src/trusted-broadcast-source-grants.js";
import { TrustedBroadcastSourceControl, validTrustedSourceStatus } from "../src/trusted-broadcast-source-control.js";
import { NativePackagerAssignmentRegistry } from "../src/native-packager-assignment.js";
import { parseNativePackagerMessage } from "../src/native-packager-control.js";
import { TrustedBroadcastSourceActions, parseTrustedSourceAction } from "../src/trusted-broadcast-source-actions.js";
import { parseClientMessage } from "../src/protocol.js";
import { steadyFixtureClock } from "./helpers/steady-fixture-clock.mjs";

const validate = new Ajv({ strict: true }).compile(JSON.parse(await fs.readFile(
  new URL("../contracts/trusted-decrypt/wire.v1.schema.json", import.meta.url), "utf8")));
const validateApproval = new Ajv({ strict: true }).compile(JSON.parse(await fs.readFile(
  new URL("../contracts/trusted-decrypt/source-approval.v1.schema.json", import.meta.url), "utf8")));
const controlAjv = new Ajv({ strict: true });
for (const name of ["wire", "source-lease"]) controlAjv.addSchema(JSON.parse(await fs.readFile(
  new URL(`../contracts/trusted-decrypt/${name}.v1.schema.json`, import.meta.url), "utf8")));
const validateControl = controlAjv.compile(JSON.parse(await fs.readFile(
  new URL("../contracts/trusted-decrypt/source-control.v1.schema.json", import.meta.url), "utf8")));
controlAjv.addSchema(JSON.parse(await fs.readFile(new URL("../contracts/trusted-decrypt/source-approval.v1.schema.json", import.meta.url), "utf8")));
const validateAction = controlAjv.compile(JSON.parse(await fs.readFile(new URL("../contracts/trusted-decrypt/source-actions.v1.schema.json", import.meta.url), "utf8")));
const validatePublisher = controlAjv.compile(JSON.parse(await fs.readFile(new URL("../contracts/trusted-decrypt/source-publisher-control.v1.schema.json", import.meta.url), "utf8")));
function fixture(start = 1800000000000, sourceProgram = false) {
  let now = start, epoch = sourceProgram ? 1 : 3;
  const issuer = "https://synthetic-identity.example/realm/source";
  const ownerIdentity = { issuer, subject: "owner", displayName: "Synthetic owner" }, identity = { issuer, subject: "publisher" };
  const rooms = new RoomRegistry();
  const owner = rooms.join("room-alpha", {}, "Synthetic owner", now, { authenticated: true,
    principal: oidcPrincipal(ownerIdentity), deviceFingerprint: "o".repeat(43) }).peer;
  const publisher = rooms.join("room-alpha", {}, "Synthetic source", now, { authenticated: true,
    principal: oidcPrincipal(identity), deviceFingerprint: "p".repeat(43) }).peer;
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const packagerId = "pkr_aaaaaaaaaaaaaaaa";
  const packagers = new NativePackagerControlRegistry({ definitions: [{ id: packagerId, label: "Synthetic packager",
    platform: "linux", ownerPrincipal: owner.principal, keyFingerprint: "k".repeat(43),
    publicKey: { ...keys.publicKey.export({ format: "jwk" }), ext: true } }] });
  const socket = {}, challenge = packagers.issueChallenge(socket, now);
  packagers.authenticate(socket, { version: 1, type: "authenticate", packagerId, timestamp: now,
    proof: crypto.sign("sha256", Buffer.from(nativePackagerAuthMessage(packagerId, challenge.nonce, now)),
      { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }, now);
  packagers.consent(owner.principal, packagerId, owner.roomId, true);
  const capability = { capabilityVersion: 2, sourcePrograms: true, agentId: packagerId, tenantId: broadcastTenantRef(issuer),
    ownerSubjectRef: broadcastSubjectRef(ownerIdentity), deviceRef: "dev_aaaaaaaaaaaaaaaa", agentVersion: "1.0.0",
    ffmpegVersion: "6.1.1", videoEncoders: ["libx264"], audioEncoders: ["aac"], hardwareClass: "medium",
    cpuClass: "medium", gpuClass: "integrated", uploadClass: "5-15mbit", energyClass: "ac", health: "healthy",
    maximumRenditions: 2, maximumPixelsPerSecond: 1280 * 720 * 30, consentedRoomIds: [owner.roomId],
    observedAt: now, expiresAt: now + 30000 };
  const refs = { tenantId: capability.tenantId, ownerSubjectRef: capability.ownerSubjectRef };
  const refreshCapability = () => packagers.setCapability(socket, { ...capability, observedAt: now, expiresAt: now + 30000 }, refs, now);
  refreshCapability();
  const runtime = new BroadcastRuntimeRegistry({ clock: () => now, grantAuthority: {
    issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {},
  } });
  const programId = runtime.createProgram(ownerIdentity, owner, { requestVersion: 1,
    roomId: owner.roomId, title: "Synthetic program", visibility: "private" }, now).control.programId;
  const prepareProgram = sourceProgram ? runtime.prepareNativeSourceProgram.bind(runtime) : runtime.prepareNativePublisher.bind(runtime);
  const prepared = prepareProgram(ownerIdentity, owner, programId, { requestVersion: 1, trigger: "user-action",
    packagerId, ...(sourceProgram ? { inputMode: "trusted-sframe-v1" } : { sourceIds: ["src_aaaaaaaaaaaaaaaa"] }),
    requestedRenditions: 1, allowHardwareAcceleration: false }, request => request, now);
  const assignments = new NativePackagerAssignmentRegistry({ controlRegistry: packagers,
    sourceProgramMembership: (_principal, _room, id) => id === owner.id ? epoch : 0,
    iceServersForPackager: () => [{ urls: ["stun:synthetic.invalid:3478"] }] });
  const prepareAssignment = sourceProgram ? assignments.prepareSourceProgram.bind(assignments) : assignments.prepare.bind(assignments);
  const installAssignment = () => {
    const assignment = prepareAssignment(owner.principal, packagerId,
      assignments.admit(owner.principal, packagerId, prepared.admission, now), prepared.lease, owner.id, now).snapshot;
    for (const state of ["ready", "starting", "running"]) assignments.acknowledge(packagerId, {
      version: 1, type: "assignment-status", assignmentId: assignment.assignmentId,
      programEpoch: assignment.programEpoch, fencingRevision: assignment.fencingRevision,
      state, reasonCode: state === "running" ? "OUTPUT_READY" : "CAPABILITY_READY", observedAt: now,
    }, now);
    return assignment;
  };
  const assignment = installAssignment();
  runtime.markNativeOutputReady(prepared.admission.resourceRef, packagerId, prepared.lease.fencingRevision, now);
  const requests = new BroadcastSourceRequests({ members: roomId => rooms.members(roomId),
    program: (...args) => runtime.nativeSourceRequestContext(...args), clock: () => now });
  const invite = sourceKind => {
    const control = runtime.nativeControl(ownerIdentity, owner, programId);
    return requests.execute(ownerIdentity, { requestVersion: 1, action: "create", trigger: "user-action", roomId: owner.roomId,
      deviceFingerprint: owner.deviceFingerprint, programId, expectedProgramRevision: control.programRevision,
      expectedProgramEpoch: control.programEpoch, targetPeerId: publisher.id, sourceKind }).requests[0];
  };
  rooms.setMediaState(publisher, { source: "camera", active: true, trackId: "track-camera" }, now);
  const request = invite("camera");
  const ports = { members: roomId => rooms.members(roomId), publication: (...args) => rooms.publication(...args),
    membershipEpoch: () => epoch, invitation: (...args) => requests.resolveForPublisher(...args),
    writer: (...args) => runtime.nativeSourceWriterContext(...args), packager: (...args) => packagers.sourceContext(...args), clock: () => now };
  const grants = new TrustedBroadcastSourceGrants(ports);
  const input = { requestVersion: 1, trigger: "user-action", requestId: request.requestId, roomId: owner.roomId,
    deviceFingerprint: publisher.deviceFingerprint, publicationId: "track-camera", expectedPublicationEpoch: 1, ttlMs: 60000 };
  const approve = () => { assert.equal(validateApproval(input), true); return grants.approve(identity, input, publisher); };
  const lookup = consent => grants.forPackager(consent.consentId, packagerId, consent.granteeDeviceRef);
  return { now: () => now, advance: ms => { now += ms; }, epoch: () => { epoch++; }, identity, ownerIdentity, rooms, owner,
    publisher, packagers, packagerId, socket, refreshCapability, runtime, programId, requests, invite, ports, grants, input, approve, lookup, assignments, assignment, capability,
    resourceRef: prepared.admission.resourceRef,
    reinstallAssignment: () => { assignments.failPackager(packagerId, "CONTROL_DISCONNECTED", now); return installAssignment(); },
    authProof: (nonce, timestamp) => crypto.sign("sha256", Buffer.from(nativePackagerAuthMessage(packagerId, nonce, timestamp)),
      { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
    reconnect: () => {
      packagers.disconnect(socket);
      const next = packagers.issueChallenge(socket, now);
      packagers.authenticate(socket, { version: 1, type: "authenticate", packagerId, timestamp: now,
        proof: crypto.sign("sha256", Buffer.from(nativePackagerAuthMessage(packagerId, next.nonce, now)),
          { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }, now);
      refreshCapability();
    } };
}

test("real membership, publication, signed agent and fenced writer produce one closed explicit source consent", () => {
  const f = fixture(), before = f.runtime.nativeControl(f.ownerIdentity, f.owner, f.programId);
  assert.equal(f.grants.auditEvents().length, 0);
  const c = f.approve();
  assert.equal(validate(c), true, JSON.stringify(validate.errors));
  assert.equal(c.grantorSubjectRef, broadcastSubjectRef(f.identity));
  assert.equal(c.granteeDeviceRef, "dev_" + "k".repeat(43));
  assert.equal(c.roomEpoch, 3); assert.equal(c.sourceKind, "camera");
  assert.notEqual(c.sourceId, "src_aaaaaaaaaaaaaaaa");
  const scope = f.lookup(c);
  assert.equal(scope.publisherPeerId, f.publisher.id); assert.equal(scope.publicationEpoch, 1);
  assert.equal(scope.publicationId, "track-camera"); assert.ok(Object.isFrozen(scope));
  assert.equal(f.grants.forPackager(c.consentId, "pkr_bbbbbbbbbbbbbbbb", c.granteeDeviceRef), null);
  assert.equal(f.grants.forPackager(c.consentId, f.packagerId, "dev_bbbbbbbbbbbbbbbb"), null);
  f.advance(1000);
  assert.strictEqual(f.approve(), c); assert.equal(f.grants.auditEvents().length, 1);
  assert.deepEqual(f.runtime.nativeControl(f.ownerIdentity, f.owner, f.programId), before);
  assert.equal(JSON.stringify(f.grants.auditEvents()).includes("track-camera"), false);
  assert.equal(JSON.stringify(f.grants.auditEvents()).includes(f.identity.issuer), false);
});

test("output availability revisions preserve current source consent without renewing its authority", () => {
  const f = fixture(1800000000000, true), consent = f.approve();
  const writer = f.runtime.nativeSourceWriterContext(f.ownerIdentity, f.owner, f.programId, f.now());
  const resource = f.resourceRef;
  f.runtime.markNativeOutputUnavailable(resource, f.packagerId, writer.fencingRevision, f.now());
  assert.ok(f.lookup(consent), "degraded output does not revoke another source");
  f.runtime.markNativeOutputReady(resource, f.packagerId, writer.fencingRevision, f.now());
  assert.ok(f.lookup(consent), "recovered output preserves the same consent");
  const recovered = f.runtime.nativeSourceWriterContext(f.ownerIdentity, f.owner, f.programId, f.now());
  assert.equal(recovered.sourceAuthorityRevision, writer.sourceAuthorityRevision);
  assert.equal(recovered.programRevision, writer.programRevision + 2);
  f.runtime.renewNativeOutput(resource, f.packagerId, writer.fencingRevision, writer.expiresAt + 1000, f.now());
  assert.ok(f.lookup(consent), "lease renewal does not confuse display and source authority");
  assert.strictEqual(f.approve(), consent, "replay never extends consent");
  f.rooms.setMediaState(f.publisher, { source: "screen", active: true, trackId: "track-screen" }, f.now());
  const invitation = f.invite("screen");
  const screen = f.grants.approve(f.identity, { ...f.input, requestId: invitation.requestId, publicationId: "track-screen",
    expectedPublicationEpoch: f.rooms.publication(f.publisher.id, "track-screen", f.owner.roomId).publicationEpoch }, f.publisher);
  assert.ok(f.lookup(screen), "new approval uses the current invitation revision after recovery");
  f.grants.revoke(f.identity, f.input.deviceFingerprint, consent.consentId);
  f.runtime.markNativeOutputUnavailable(resource, f.packagerId, writer.fencingRevision, f.now());
  f.runtime.markNativeOutputReady(resource, f.packagerId, writer.fencingRevision, f.now());
  assert.equal(f.lookup(consent), null, "output recovery cannot revive a revoked source");
  assert.ok(f.lookup(screen), "revoking one source preserves the other");
  f.runtime.stopProgram(f.ownerIdentity, f.programId, f.now());
  assert.equal(f.lookup(screen), null, "real program stop still removes source authority");
});

test("missing, future or changed internal source authority revision invalidates existing grants", () => {
  for (const value of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(), writer = f.ports.writer;
    let changed = false;
    const grants = new TrustedBroadcastSourceGrants({ ...f.ports, writer: (...args) => {
      const current = writer(...args);
      return changed ? { ...current, sourceAuthorityRevision: value } : current;
    } });
    const consent = grants.approve(f.identity, f.input, f.publisher);
    changed = true;
    assert.equal(grants.forPackager(consent.consentId, f.packagerId, consent.granteeDeviceRef), null);
    changed = false;
    assert.equal(grants.forPackager(consent.consentId, f.packagerId, consent.granteeDeviceRef), null);
  }
});

test("approval input cannot inject authority, omit fields or change its bound publication on replay", () => {
  const f = fixture();
  for (const field of Object.keys(f.input)) {
    const input = { ...f.input }; delete input[field];
    assert.equal(validateApproval(input), false);
    assert.throws(() => f.grants.approve(f.identity, input), /invalid_trusted_source_approval/);
  }
  for (const input of [{ ...f.input, sourceId: "src_aaaaaaaaaaaaaaaa" }, { ...f.input, consent: true },
    { ...f.input, trigger: "remote-signal" }, { ...f.input, ttlMs: 600001 }, { ...f.input, ttlMs: 4999 },
    { ...f.input, expectedPublicationEpoch: 0 }, { ...f.input, publicationId: "bad track" }]) {
    assert.throws(() => f.grants.approve(f.identity, input), /invalid_trusted_source_approval/);
    assert.equal(validateApproval(input), false);
  }
  f.approve();
  assert.throws(() => f.grants.approve(f.identity, { ...f.input, ttlMs: 30000 }, f.publisher), /stale/);
  assert.throws(() => f.grants.approve(f.identity, { ...f.input, expectedPublicationEpoch: 2 }, f.publisher), /stale/);
  assert.throws(() => f.grants.approve(f.ownerIdentity, f.input, f.publisher), /connection_required/);
});

test("v4 controller owns its four source consents only after a separate current-publication approval", () => {
  const f = fixture(1800000000000, true);
  for (const sourceKind of ["camera", "microphone", "screen", "screen-audio"]) {
    const control = f.runtime.nativeControl(f.ownerIdentity, f.owner, f.programId);
    const item = f.requests.execute(f.ownerIdentity, { requestVersion: 1, action: "create-own", trigger: "user-action",
      roomId: f.owner.roomId, deviceFingerprint: f.owner.deviceFingerprint, programId: f.programId,
      expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch, sourceKind }).requests[0];
    const input = { ...f.input, requestId: item.requestId, publicationId: "own-" + sourceKind, deviceFingerprint: f.owner.deviceFingerprint };
    assert.throws(() => f.grants.approve(f.ownerIdentity, input, f.owner), /unavailable/);
    f.rooms.setMediaState(f.owner, { source: sourceKind, active: true, trackId: input.publicationId }, f.now());
    input.expectedPublicationEpoch = f.rooms.publication(f.owner.id, input.publicationId, f.owner.roomId).publicationEpoch;
    assert.throws(() => f.grants.approve(f.identity, input, f.publisher), /connection_required|unavailable/);
    const consent = f.grants.approve(f.ownerIdentity, input, f.owner);
    assert.equal(validate(consent), true); assert.equal(consent.grantorSubjectRef, broadcastSubjectRef(f.ownerIdentity));
    assert.equal(f.lookup(consent).publisherPeerId, f.owner.id); assert.equal(consent.sourceKind, sourceKind);
    f.grants.revoke(f.ownerIdentity, f.owner.deviceFingerprint, consent.consentId);
    assert.equal(f.lookup(consent), null);
    assert.ok(f.rooms.publication(f.owner.id, input.publicationId, f.owner.roomId), "revoking the broadcast does not stop the room publication");
  }
});

test("uninvited identities, devices, kinds, generations and inactive sources cannot approve", () => {
  for (const mutate of [
    f => { f.input.deviceFingerprint = f.owner.deviceFingerprint; },
    f => { f.input.publicationId = "track-invented"; },
    f => { f.input.expectedPublicationEpoch = 2; },
    f => { f.publisher.authenticated = false; },
    f => { f.publisher.machine = true; },
    f => { f.rooms.setMediaState(f.publisher, { source: "camera", active: false }, f.now()); },
    f => { f.rooms.setMediaState(f.publisher, { source: "screen", active: true, trackId: "track-camera" }, f.now()); },
    f => { f.packagers.consent(f.owner.principal, f.packagerId, f.owner.roomId, false); },
    f => { f.advance(31000); },
    f => { f.requests.execute(f.identity, { requestVersion: 1, action: "decline", trigger: "user-action",
      roomId: f.input.roomId, deviceFingerprint: f.input.deviceFingerprint, requestId: f.input.requestId }); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => f.approve()); assert.equal(f.grants.auditEvents().length, 0);
  }
});

test("an account and public fingerprint cannot replace the actual bound signaling peer, including on replay", () => {
  const f = fixture();
  for (const actor of [undefined, { ...f.publisher }, f.owner, {}]) {
    assert.throws(() => f.grants.approve(f.identity, f.input, actor), /connection_required/);
  }
  f.approve();
  assert.throws(() => f.grants.approve(f.identity, f.input), /connection_required/);
  const second = f.rooms.join(f.input.roomId, {}, "Synthetic duplicate", f.now(), { authenticated: true,
    principal: f.publisher.principal, deviceFingerprint: f.publisher.deviceFingerprint }).peer;
  assert.throws(() => f.grants.approve(f.identity, f.input, second), /connection_required/);
});

test("source stop/restart, same-device rejoin, epoch/lease/room consent loss revoke terminally", () => {
  for (const mutate of [
    f => { f.rooms.setMediaState(f.publisher, { source: "camera", active: false }, f.now());
      f.rooms.setMediaState(f.publisher, { source: "camera", active: true, trackId: "track-camera" }, f.now()); },
    f => { f.rooms.leave(f.publisher); f.rooms.join(f.input.roomId, {}, "Synthetic rejoin", f.now(), {
      authenticated: true, principal: f.publisher.principal, deviceFingerprint: f.publisher.deviceFingerprint }); },
    f => { f.rooms.leave(f.owner); }, f => { f.epoch(); },
    f => { f.publisher.deviceFingerprint = "q".repeat(43); },
    f => { f.runtime.stopProgram(f.ownerIdentity, f.programId); },
    f => { f.packagers.consent(f.owner.principal, f.packagerId, f.input.roomId, false); },
    f => { f.advance(31000); },
  ]) {
    const f = fixture(), c = f.approve(); mutate(f);
    assert.deepEqual(f.grants.prune(), [c.consentId]); assert.equal(f.lookup(c), null);
    assert.deepEqual(f.grants.prune(), []);
    assert.equal(f.grants.auditEvents().at(-1).eventType, "consent-revoked");
    assert.throws(() => f.approve(), /stale|connection_required/);
  }
});

test("publisher revokes without moderator approval; wrong account/device cannot revoke", () => {
  const f = fixture(), c = f.approve();
  assert.throws(() => f.grants.revoke(f.ownerIdentity, f.input.deviceFingerprint, c.consentId), /unavailable/);
  assert.throws(() => f.grants.revoke(f.identity, "q".repeat(43), c.consentId), /unavailable/);
  assert.equal(f.grants.revoke(f.identity, f.input.deviceFingerprint, c.consentId).status, "revoked");
  assert.equal(f.lookup(c), null);
  f.grants.revoke(f.identity, f.input.deviceFingerprint, c.consentId);
  assert.equal(f.grants.auditEvents().length, 2);
  assert.throws(() => f.approve(), /stale/);
});

test("clock rollback, invalid clock and destroy cannot revive consent", () => {
  for (const ms of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(), c = f.approve(); f.advance(ms);
    assert.throws(() => f.lookup(c), /clock/);
    assert.equal(f.grants.auditEvents().at(-1).eventType, "consent-revoked");
    assert.throws(() => f.lookup(c), /closed/);
  }
  const f = fixture(); f.approve(); f.grants.destroy(); f.grants.destroy();
  assert.throws(() => f.approve(), /closed/);
});

test("idempotent requests are rate-bounded and consent expires without a lease extension", () => {
  const f = fixture(), c = f.approve();
  for (let i = 1; i < 60; i++) assert.strictEqual(f.approve(), c);
  assert.throws(() => f.approve(), /rate/);
  f.advance(60000); assert.equal(f.lookup(c), null);
  assert.equal(f.grants.auditEvents().at(-1).reasonCode, "expired");
});

test("transient room consent loss, capability expiry and reconnect cannot be hidden by restoring current state", () => {
  for (const mutate of [
    f => { f.packagers.consent(f.owner.principal, f.packagerId, f.input.roomId, false);
      f.packagers.consent(f.owner.principal, f.packagerId, f.input.roomId, true); f.refreshCapability(); },
    f => { f.advance(31000); f.refreshCapability(); },
    f => { f.reconnect(); },
  ]) {
    const f = fixture(), c = f.approve(); mutate(f);
    // No prune/lookup happened during the invalid interval.
    assert.equal(f.lookup(c), null);
    assert.throws(() => f.approve(), /stale/);
  }
  const f = fixture(), c = f.approve(); f.advance(1000); f.refreshCapability();
  assert.ok(f.lookup(c), "ordinary capability refresh must preserve scope");
});

test("source-program opt-out and immediate opt-in cannot revive an earlier source consent", () => {
  for (const downgrade of ["disabled", "legacy"]) {
    const f = fixture(), consent = f.approve();
    const refs = { tenantId: f.capability.tenantId, ownerSubjectRef: f.capability.ownerSubjectRef };
    const changed = { ...f.capability, sourcePrograms: false };
    if (downgrade === "legacy") { changed.capabilityVersion = 1; delete changed.sourcePrograms; }
    f.packagers.setCapability(f.socket, changed, refs, f.now());
    f.refreshCapability(); // No broker tick or grant lookup occurred during opt-out.
    assert.equal(f.lookup(consent), null);
    assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running", "source revoke does not terminate the parent");
  }
});

test("the real program's pending fenced handoff revokes all predecessor source authority", () => {
  const f = fixture(), c = f.approve(), control = f.runtime.nativeControl(f.ownerIdentity, f.owner, f.programId);
  f.runtime.beginNativeHandoff(f.ownerIdentity, f.owner, f.programId, { requestVersion: 1, trigger: "user-action",
    packagerId: "pkr_bbbbbbbbbbbbbbbb", expectedProgramRevision: control.programRevision,
    expectedProgramEpoch: control.programEpoch, expectedFencingRevision: control.writer.fencingRevision,
    requestedRenditions: 1, allowHardwareAcceleration: false }, request => request, f.now());
  assert.equal(f.lookup(c), null);
  assert.throws(() => f.approve(), /stale/);
});

test("all four distinct publication kinds have separate consent and revocation cannot reset the quota", () => {
  const f = fixture(), camera = f.approve();
  for (const kind of ["microphone", "screen", "screen-audio"]) {
    const track = `track-${kind}`;
    f.rooms.setMediaState(f.publisher, { source: kind, active: true, trackId: track }, f.now());
    const request = f.invite(kind), publication = f.rooms.publication(f.publisher.id, track, f.input.roomId);
    const consent = f.grants.approve(f.identity, { ...f.input, requestId: request.requestId,
      publicationId: track, expectedPublicationEpoch: publication.publicationEpoch }, f.publisher);
    assert.equal(validate(consent), true); assert.equal(consent.sourceKind, kind);
  }
  f.grants.revoke(f.identity, f.input.deviceFingerprint, camera.consentId);
  f.requests.execute(f.ownerIdentity, { requestVersion: 1, action: "cancel", trigger: "user-action", roomId: f.input.roomId,
    deviceFingerprint: f.owner.deviceFingerprint, requestId: f.input.requestId });
  const next = f.invite("camera");
  assert.throws(() => f.grants.approve(f.identity, { ...f.input, requestId: next.requestId }, f.publisher), /quota/);
});

test("publication references and source IDs are server owned; invalid IDs cannot commit a consent", () => {
  const f = fixture();
  const wrongTarget = new TrustedBroadcastSourceGrants({ ...f.ports, packager: (...args) => ({ ...f.ports.packager(...args),
    capability: { ...f.ports.packager(...args).capability, tenantId: "tn_bbbbbbbbbbbbbbbb" } }) });
  assert.throws(() => wrongTarget.approve(f.identity, f.input, f.publisher), /packager/);
  const invalid = new TrustedBroadcastSourceGrants({ ...f.ports, sourceId: () => "not-a-source" });
  assert.throws(() => invalid.approve(f.identity, f.input, f.publisher), /identifier/);
  assert.equal(invalid.auditEvents().length, 0);
  assert.throws(() => new TrustedBroadcastSourceGrants({ ...f.ports, publication: null }), /ports/);
});

function sourceControlFixture() {
  const f = fixture(), messages = [], publisherMessages = [], consent = f.approve();
  let deliver = true, publisherDelivery = true;
  const broker = new TrustedBroadcastSourceControl({ grants: f.grants, assignments: f.assignments, control: f.packagers,
    members: roomId => f.rooms.members(roomId), sendSignal: (socket, message) => { messages.push({ socket, message }); return deliver; },
    sendPublisher: (socket, message) => {
      assert.equal(validatePublisher(message), true, JSON.stringify(validatePublisher.errors));
      publisherMessages.push({ socket, message }); return publisherDelivery;
    },
    clock: f.now, send: (socket, message) => {
      assert.equal(socket, f.socket); assert.equal(validateControl(message), true, JSON.stringify(validateControl.errors));
      messages.push(message); return deliver;
    } });
  const prepare = () => broker.prepare(consent.consentId, f.socket);
  const ack = lease => ({ version: 1, type: "trusted-source-status", sourceLeaseId: lease.sourceLeaseId,
    leaseRevision: lease.revision, consentId: consent.consentId, assignmentId: lease.assignmentId,
    fencingRevision: lease.fencingRevision, state: "receiver-prepared", expiresAt: lease.expiresAt, observedAt: f.now() });
  return { ...f, broker, messages, publisherMessages, consent, prepare, ack, failDelivery: () => { deliver = false; },
    failPublisher: () => { publisherDelivery = false; } };
}

function sourceSignal(lease, publisher = true, sequence = 1) {
  return { version: 1, type: publisher ? "trusted-source-publisher-signal" : "trusted-source-packager-signal",
    sourceLeaseId: lease.sourceLeaseId, consentId: lease.consent.consentId, assignmentId: lease.assignmentId,
    fencingRevision: lease.fencingRevision, negotiationRevision: 1, sequence,
    description: { type: publisher ? "offer" : "answer", sdp: "v=0\r\n" } };
}

function publisherContext(f, lease) {
  return { roomId: f.input.roomId, programId: f.programId, programEpoch: lease.consent.programEpoch,
    packagerId: f.packagerId, assignmentId: lease.assignmentId, writerLeaseId: lease.writerLeaseId,
    fencingRevision: lease.fencingRevision };
}

test("internal publisher bindings expose only prepared current scoped peer references without new authority", () => {
  const f = sourceControlFixture(), lease = f.prepare(), context = publisherContext(f, lease);
  assert.deepEqual(f.broker.publisherBindings(context, [lease.sourceLeaseId]), []);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), true);
  const messages = f.messages.length, publisherMessages = f.publisherMessages.length;
  const rows = f.broker.publisherBindings(context, ["sls_bbbbbbbbbbbbbbbb", lease.sourceLeaseId]);
  assert.deepEqual(rows, [{ sourceLeaseId: lease.sourceLeaseId, publisherPeerId: f.publisher.id, sourceKind: "camera" }]);
  assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0]));
  assert.equal(f.messages.length, messages); assert.equal(f.publisherMessages.length, publisherMessages);
  assert.strictEqual(f.prepare(), lease, "lookup neither issues nor renews a lease");
  assert.doesNotMatch(JSON.stringify(rows), /Synthetic|principal|fingerprint|consent|publicationId|writer|secret|key|https:/);
  f.broker.destroy(); assert.throws(() => f.broker.publisherBindings(context, []), /closed/);
});

test("publisher binding probes cannot inspect or stop a foreign scope and reject malformed bounds", () => {
  const f = sourceControlFixture(), lease = f.prepare(), context = publisherContext(f, lease);
  f.broker.acknowledge(f.socket, f.ack(lease));
  let reads = 0;
  const original = f.grants.forPackager.bind(f.grants);
  f.grants.forPackager = (...args) => { reads++; return original(...args); };
  for (const patch of [{ roomId: "room-other" }, { programId: "prg_bbbbbbbbbbbbbbbb" }, { programEpoch: context.programEpoch + 1 },
    { packagerId: "pkr_bbbbbbbbbbbbbbbb" }, { assignmentId: "asn_bbbbbbbbbbbbbbbb" },
    { writerLeaseId: "lea_bbbbbbbbbbbbbbbb" }, { fencingRevision: context.fencingRevision + 1 }]) {
    assert.deepEqual(f.broker.publisherBindings({ ...context, ...patch }, [lease.sourceLeaseId]), []);
  }
  assert.equal(reads, 0, "foreign scope is rejected before grant inspection");
  assert.equal(f.messages.length, 1); assert.strictEqual(f.prepare(), lease);
  for (const value of [null, {}, { ...context, extra: true }, { ...context, programEpoch: Infinity }]) {
    assert.throws(() => f.broker.publisherBindings(value, []), /invalid_source_publisher_context/);
  }
  for (const ids of [null, {}, [lease.sourceLeaseId, lease.sourceLeaseId], Array(81).fill(lease.sourceLeaseId), ["bad-id"]]) {
    assert.throws(() => f.broker.publisherBindings(context, ids), /invalid_source_publisher_context/);
  }
  assert.deepEqual(f.broker.publisherBindings(context, Array.from({ length: 80 }, (_, i) => "sls_" + String(i).padStart(16, "0"))), []);
  f.advance(4000);
  assert.deepEqual(f.broker.publisherBindings({ ...context, roomId: "room-other" }, [lease.sourceLeaseId]), []);
  assert.equal(f.messages.length, 1, "even expired foreign-scoped records are not inspected or stopped by this probe");
  f.broker.destroy();
});

test("publisher bindings disappear after source, membership, writer, socket, consent or time loss", () => {
  for (const lose of [f => f.rooms.setMediaState(f.publisher, { source: "camera", active: false }, f.now()),
    f => f.rooms.leave(f.publisher), f => f.epoch(), f => f.packagers.disconnect(f.socket),
    f => f.assignments.stop(f.owner.principal, f.packagerId, f.assignment.assignmentId, "TEST_STOP", f.now()),
    f => f.grants.revoke(f.identity, f.input.deviceFingerprint, f.consent.consentId), f => f.advance(4000)]) {
    const f = sourceControlFixture(), lease = f.prepare(), context = publisherContext(f, lease);
    f.broker.acknowledge(f.socket, f.ack(lease)); lose(f);
    assert.deepEqual(f.broker.publisherBindings(context, [lease.sourceLeaseId]), []);
    f.broker.destroy();
  }
  const f = sourceControlFixture(), lease = f.prepare();
  f.broker.acknowledge(f.socket, f.ack(lease)); f.advance(-1);
  assert.throws(() => f.broker.publisherBindings(publisherContext(f, lease), [lease.sourceLeaseId]), /clock_invalid/);
});

test("source signaling resolves actual publisher/agent sockets and rejects forged, expired or replayed routes", () => {
  const f = sourceControlFixture(), lease = f.prepare(), offer = sourceSignal(lease);
  assert.equal(f.broker.publisherSignal(f.publisher, offer), false, "receiver must acknowledge preparation first");
  assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), true);
  assert.equal(f.broker.publisherSignal({ ...f.publisher }, offer), false, "a copied peer is not a connected actor");
  assert.equal(f.broker.publisherSignal(f.owner, offer), false);
  for (const patch of [{ consentId: "cns_bbbbbbbbbbbbbbbb" }, { assignmentId: "asn_bbbbbbbbbbbbbbbb" }, { fencingRevision: lease.fencingRevision + 1 }]) {
    assert.equal(f.broker.publisherSignal(f.publisher, { ...offer, ...patch }), false);
  }
  assert.equal(f.broker.publisherSignal(f.publisher, offer), true);
  assert.equal(f.messages.at(-1).socket, f.socket);
  assert.deepEqual(f.messages.at(-1).message, { ...offer, type: "trusted-source-peer-signal", publisherPeerId: f.publisher.id });
  const before = f.messages.length;
  assert.equal(f.broker.publisherSignal(f.publisher, offer), false); assert.equal(f.messages.length, before);
  const answer = sourceSignal(lease, false);
  assert.equal(f.broker.packagerSignal({}, answer), false);
  assert.equal(f.broker.packagerSignal(f.socket, answer), true);
  assert.equal(f.messages.at(-1).socket, f.publisher.socket);
  assert.deepEqual(f.messages.at(-1).message, { ...answer, type: "trusted-source-agent-signal",
    packagerId: f.packagerId, packagerDeviceRef: lease.consent.granteeDeviceRef });
  f.advance(1000); f.broker.tick();
  const candidate = { ...offer, sequence: 2, candidate: null }; delete candidate.description;
  assert.equal(f.broker.publisherSignal(f.publisher, candidate), true, "unconfirmed next lease revision does not lose previous receiver ACK");
  f.grants.revoke(f.identity, f.input.deviceFingerprint, f.consent.consentId);
  assert.equal(f.broker.publisherSignal(f.publisher, { ...candidate, sequence: 3 }), false);
  assert.equal(f.messages.at(-1).type, "trusted-source-stop");
});

test("source signaling never reaches a control-only agent and delivery failure terminates only the source", () => {
  const f = sourceControlFixture(), lease = f.prepare(); f.broker.acknowledge(f.socket, f.ack(lease));
  f.packagers.setCapability(f.socket, { ...f.capability, sourcePrograms: false }, {
    tenantId: f.capability.tenantId, ownerSubjectRef: f.capability.ownerSubjectRef,
  }, f.now());
  assert.equal(f.broker.publisherSignal(f.publisher, sourceSignal(lease)), false);
  assert.equal(f.messages.length, 1);
  const g = sourceControlFixture(), l = g.prepare(); g.broker.acknowledge(g.socket, g.ack(l)); g.failDelivery();
  assert.equal(g.broker.publisherSignal(g.publisher, sourceSignal(l)), false);
  assert.equal(g.messages.at(-1).type, "trusted-source-stop");
  assert.equal(g.assignments.activeForPackager(g.packagerId).state, "running");
  assert.throws(() => g.prepare(), /terminal/);
  const h = sourceControlFixture(), last = h.prepare(); h.broker.acknowledge(h.socket, h.ack(last));
  assert.equal(h.broker.publisherSignal(h.publisher, sourceSignal(last)), true);
  h.packagers.setCapability(h.socket, { ...h.capability, sourcePrograms: false }, {
    tenantId: h.capability.tenantId, ownerSubjectRef: h.capability.ownerSubjectRef,
  }, h.now());
  h.broker.tick(); assert.equal(h.messages.at(-1).type, "trusted-source-stop");
});

test("source broker uses real authenticated control, authority and running fenced assignment; ACK gates renewal", () => {
  const f = sourceControlFixture();
  assert.throws(() => f.broker.prepare(f.consent.consentId, {}), /connection_required/);
  assert.throws(() => f.broker.prepare("cns_bbbbbbbbbbbbbbbb", f.socket), /consent_unavailable/);
  const lease = f.prepare();
  assert.equal(lease.assignmentId, f.assignment.assignmentId);
  assert.equal(lease.expiresAt - lease.issuedAt, 4000);
  assert.equal(lease.codec, "video/vp8");
  assert.equal(f.messages.length, 1);
  assert.strictEqual(f.prepare(), lease);
  assert.equal(f.messages.length, 1, "replay does not resend or renew");
  f.advance(1000); f.broker.tick(); assert.equal(f.messages.length, 1);
  const status = f.ack(lease);
  assert.equal(validateControl(status), true); assert.equal(validTrustedSourceStatus(status), true);
  assert.deepEqual(parseNativePackagerMessage(JSON.stringify(status)), status);
  assert.equal(f.broker.acknowledge(f.socket, status), true);
  f.broker.tick();
  const renewed = f.messages.at(-1).lease;
  assert.equal(renewed.revision, 2); assert.equal(renewed.expiresAt, lease.expiresAt + 1000);
  assert.strictEqual(renewed.consent, lease.consent);
  f.advance(1000);
  assert.equal(f.broker.acknowledge(f.socket, status), false, "old ACK cannot confirm renewal");
  f.broker.tick(); assert.equal(f.messages.length, 2);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(renewed)), true);
  f.broker.tick(); assert.equal(f.messages.at(-1).lease.revision, 3);
  f.broker.destroy(); assert.equal(f.messages.at(-1).type, "trusted-source-stop");
  for (const message of f.messages) {
    for (const key of Object.keys(message)) {
      const bad = { ...message }; delete bad[key]; assert.equal(validateControl(bad), false);
    }
    assert.equal(validateControl({ ...message, keys: [] }), false);
  }
  assert.throws(() => f.prepare(), /closed/);
});

test("source broker expiry and control delivery failure are terminal, including idempotent prepare", () => {
  for (const fail of [f => f.advance(4000), f => f.failDelivery()]) {
    const f = sourceControlFixture(), lease = f.prepare();
    assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), true);
    fail(f); f.advance(1000); f.broker.tick();
    assert.equal(f.messages.at(-1).type, "trusted-source-stop");
    assert.throws(() => f.prepare(), /terminal/);
    assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), false);
    assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running", "source failure does not stop parent program");
  }
  const f = sourceControlFixture(); f.failDelivery();
  assert.throws(() => f.prepare(), /delivery_failed/);
  assert.throws(() => f.prepare(), /terminal/);
});

test("source broker revokes on publication, room, membership, parent, socket, consent and clock authority loss", () => {
  for (const lose of [
    f => f.rooms.setMediaState(f.publisher, { source: "camera", active: false }, f.now()),
    f => f.packagers.consent(f.owner.principal, f.packagerId, f.input.roomId, false),
    f => f.epoch(), f => f.rooms.leave(f.publisher),
    f => f.assignments.stop(f.owner.principal, f.packagerId, f.assignment.assignmentId, "TEST_STOP", f.now()),
    f => f.grants.revoke(f.identity, f.input.deviceFingerprint, f.consent.consentId),
  ]) {
    const f = sourceControlFixture(), lease = f.prepare(); lose(f); f.broker.tick();
    assert.equal(f.messages.at(-1).type, "trusted-source-stop");
    assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), false);
  }
  const f = sourceControlFixture(), lease = f.prepare(); f.reconnect(); f.broker.tick();
  assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), false, "same socket object with new auth generation cannot revive consent");
  const g = sourceControlFixture(); g.prepare(); g.advance(-1);
  assert.throws(() => g.broker.tick(), /clock_invalid/);
  assert.equal(g.messages.at(-1).type, "trusted-source-stop");
  assert.throws(() => g.broker.tick(), /closed/);
});

test("source status contracts reject extra or missing fields and scope-confused ACKs cannot activate receivers", () => {
  const f = sourceControlFixture(), lease = f.prepare(), valid = f.ack(lease);
  for (const key of Object.keys(valid)) {
    const value = { ...valid }; delete value[key];
    assert.equal(validateControl(value), false); assert.equal(validTrustedSourceStatus(value), false);
    assert.throws(() => parseNativePackagerMessage(JSON.stringify(value)));
  }
  assert.equal(validateControl({ ...valid, key: "forbidden" }), false);
  assert.throws(() => parseNativePackagerMessage(JSON.stringify({ ...valid, key: "forbidden" })));
  assert.equal(f.broker.acknowledge({}, valid), false);
  for (const patch of [{ consentId: "cns_bbbbbbbbbbbbbbbb" }, { assignmentId: "asn_bbbbbbbbbbbbbbbb" }, { fencingRevision: lease.fencingRevision + 1 }]) {
    assert.equal(f.broker.acknowledge(f.socket, { ...valid, ...patch }), false);
  }
  f.advance(1000); f.broker.tick(); assert.equal(f.messages.length, 1);
  for (const patch of [{ leaseRevision: 2 }, { expiresAt: lease.expiresAt + 1 }, { state: "failed" }, { observedAt: f.now() + 5000 }]) {
    const g = sourceControlFixture(), l = g.prepare();
    assert.equal(g.broker.acknowledge(g.socket, { ...g.ack(l), ...patch }), false);
    assert.equal(g.messages.at(-1).type, "trusted-source-stop");
  }
});

test("source ACK budget is separate and bounded without refreshing any lease", () => {
  const f = sourceControlFixture(), lease = f.prepare();
  for (let i = 0; i < 1024; i++) assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), true);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), false);
  assert.equal(f.messages.length, 1);
  assert.equal(f.packagers.allowMessage(f.socket, f.now()), true, "assignment budget unaffected");
  f.advance(4000); f.broker.tick(); assert.equal(f.messages.at(-1).type, "trusted-source-stop");
});

test("source control will not send new messages to a legacy or unknown native version", () => {
  for (const version of ["0.7.0", "0.7.9", "unknown", "0.8.0-beta.1"]) {
    const f = sourceControlFixture();
    f.packagers.setCapability(f.socket, { ...f.capability, agentVersion: version }, {
      tenantId: f.capability.tenantId, ownerSubjectRef: f.capability.ownerSubjectRef,
    }, f.now());
    assert.throws(() => f.prepare(), /upgrade_required/);
    assert.equal(f.messages.length, 0); assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running");
  }
  const f = sourceControlFixture();
  f.packagers.setCapability(f.socket, { ...f.capability, agentVersion: "0.8.0" }, {
    tenantId: f.capability.tenantId, ownerSubjectRef: f.capability.ownerSubjectRef,
  }, f.now());
  f.prepare(); assert.equal(f.messages.length, 1);
});

test("approve budget rejects excess replays before expensive full authority pruning", () => {
  const f = fixture(); let checks = 0;
  const grants = new TrustedBroadcastSourceGrants({ ...f.ports, writer: (...args) => { checks++; return f.ports.writer(...args); } });
  for (let i = 0; i < 60; i++) grants.approve(f.identity, f.input, f.publisher);
  const previous = checks;
  assert.throws(() => grants.approve(f.identity, f.input, f.publisher), /rate/);
  assert.equal(checks, previous);
});

for (const publicActions of [false, true, "receipt-failure", "backpressure"]) test(`live ${publicActions ? `public v4 ${publicActions}` : "internal source"} signaling renews only after ACK and stops on publisher revoke`, { timeout: 10000 }, async t => {
  steadyFixtureClock(t); // Synthetic policy times only; no production clock/lease change.
  const f = fixture(Date.now(), publicActions), keys = crypto.generateKeyPairSync("ed25519");
  f.rooms.leave(f.publisher);
  const config = { authMode: "required", oidcIssuer: f.identity.issuer, oidcAudience: "human", oidcAlgorithms: ["EdDSA"],
    publicOrigin: "https://synthetic-fixture.example", nativePackagerSelfServiceEnabled: true, stunUrls: [], turnServers: [] };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }) });
  const app = createAppServer({ config, oidcVerifier, registry: f.rooms, broadcastRuntime: f.runtime, nativePackagers: f.packagers,
    nativePackagerAssignments: f.assignments,
    nativePackagerEnrollmentStore: { definitions: () => [] }, nativePackagerInstallerService: {} });
  let socket, nativeSocket;
  t.after(async () => {
    socket?.terminate();
    nativeSocket?.terminate();
    for (const peer of app.webSocketServer.clients) peer.terminate();
    await new Promise(resolve => app.webSocketServer.close(resolve));
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.throws(() => app.trustedBroadcastSources.prune(), /closed/);
    assert.throws(() => app.trustedBroadcastSourceControl.tick(), /closed/);
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const until = async (predicate, observe = () => ({})) => {
    const wallStart = Date.now(), monotonicStart = performance.now(), deadline = wallStart + 3000;
    while (!predicate()) {
      if (Date.now() >= deadline) t.diagnostic(JSON.stringify({ schema: "synthetic-signaling-wait.v1",
        wallElapsedMs: Date.now() - wallStart, monotonicElapsedMs: performance.now() - monotonicStart, ...observe() }));
      assert.ok(Date.now() < deadline, "bounded signaling observation expired");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  f.packagers.disconnect(f.socket);
  const nativeMessages = [];
  nativeSocket = new WebSocket(`${base.replace("http:", "ws:")}/native-packager`);
  nativeSocket.on("message", raw => nativeMessages.push(JSON.parse(raw)));
  await once(nativeSocket, "open");
  await until(() => nativeMessages.some(message => message.type === "packager-challenge"));
  const timestamp = Date.now(), challenge = nativeMessages.find(message => message.type === "packager-challenge");
  nativeSocket.send(JSON.stringify({ version: 1, type: "authenticate", packagerId: f.packagerId, timestamp,
    proof: f.authProof(challenge.nonce, timestamp) }));
  await until(() => nativeMessages.some(message => message.type === "room-consent-sync"));
  nativeSocket.send(JSON.stringify({ version: 1, type: "capability", capability: {
    ...f.capability, observedAt: Date.now(), expiresAt: Date.now() + 30000,
  } }));
  await until(() => nativeMessages.some(message => message.type === "capability-accepted"));
  if (publicActions) f.reinstallAssignment(); // Fresh binding after the test's explicit native reconnect.
  // Explicit ephemeral session-policy fixture; this is not a PKCE/device-proof gate.
  const issued = app.ticketStore.issue({ origin: config.publicOrigin, roomId: f.input.roomId, mode: "room",
    name: "Synthetic source", authenticated: true, principal: oidcPrincipal(f.identity), deviceFingerprint: f.input.deviceFingerprint,
    sourceIdentity: f.identity });
  socket = new WebSocket(`${base.replace("http:", "ws:")}/signal?ticket=${issued.ticket}`, { origin: config.publicOrigin });
  const browserMessages = [];
  socket.on("message", raw => browserMessages.push(JSON.parse(raw)));
  const welcome = new Promise(resolve => socket.on("message", raw => { const value = JSON.parse(raw); if (value.type === "welcome") resolve(value); }));
  await once(socket, "open"); const joined = await welcome;
  socket.send(JSON.stringify({ type: "media-state", source: "camera", active: true, trackId: f.input.publicationId }));
  await until(() => f.rooms.publication(joined.peerId, f.input.publicationId, f.input.roomId));
  const control = f.runtime.nativeControl(f.ownerIdentity, f.owner, f.programId);
  const token = await new SignJWT({}).setIssuer(f.identity.issuer).setAudience("human").setSubject(f.ownerIdentity.subject)
    .setIssuedAt().setExpirationTime("2m").setProtectedHeader({ alg: "EdDSA" }).sign(keys.privateKey);
  const response = await fetch(base + "/api/broadcast-source-requests", { method: "POST", headers: {
    origin: config.publicOrigin, "content-type": "application/json", authorization: `Bearer ${token}`,
  }, body: JSON.stringify({ requestVersion: 1, action: "create", trigger: "user-action", roomId: f.input.roomId,
    deviceFingerprint: f.owner.deviceFingerprint, programId: f.programId, expectedProgramRevision: control.programRevision,
    expectedProgramEpoch: control.programEpoch, targetPeerId: joined.peerId, sourceKind: "camera" }) });
  assert.equal(response.status, 201);
  const requestId = (await response.json()).requests[0].requestId;
  const actor = f.rooms.members(f.input.roomId).find(peer => peer.id === joined.peerId);
  if (publicActions === "receipt-failure") {
    const send = actor.socket.send.bind(actor.socket);
    actor.socket.send = (raw, ...args) => {
      if (JSON.parse(raw).type === "trusted-source-approved") throw new Error("synthetic_send_failure");
      return send(raw, ...args);
    };
  }
  let c, lease;
  if (publicActions) {
    socket.send(JSON.stringify({ version: 1, type: "trusted-source-publications" }));
    await until(() => browserMessages.some(message => message.type === "trusted-source-publications"));
    const own = browserMessages.find(message => message.type === "trusted-source-publications");
    assert.equal(validatePublisher(own), true); assert.equal(own.peerId, joined.peerId);
    assert.deepEqual(own.publications, [{ publicationId: f.input.publicationId, source: "camera", publicationEpoch: 1 }]);
    if (publicActions === "backpressure") Object.defineProperty(actor.socket, "bufferedAmount", { configurable: true, get: () => 65537 });
    socket.send(JSON.stringify({ version: 1, type: "trusted-source-approve",
      approval: { ...f.input, requestId, expectedPublicationEpoch: own.publications[0].publicationEpoch } }));
    if (typeof publicActions === "string") {
      await until(() => app.trustedBroadcastSources.auditEvents().some(event => event.eventType === "consent-revoked"));
      await until(() => nativeMessages.some(message => message.type === "trusted-source-stop"));
      assert.equal(browserMessages.some(message => message.type === "trusted-source-approved"), false);
      assert.equal(browserMessages.some(message => message.type === "trusted-source-publisher-lease"), false);
      assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running");
      return;
    }
    await until(() => browserMessages.some(message => message.type === "trusted-source-approved"));
    const receipt = browserMessages.find(message => message.type === "trusted-source-approved");
    assert.equal(validatePublisher(receipt), true); c = receipt.consent;
    await until(() => nativeMessages.some(message => message.type === "trusted-source-prepare"));
    lease = nativeMessages.find(message => message.type === "trusted-source-prepare").lease;
  } else {
    c = app.trustedBroadcastSources.approve(f.identity, { ...f.input, requestId }, actor);
    lease = app.trustedBroadcastSourceControl.prepare(c.consentId, f.packagers.socketFor(f.packagerId));
  }
  assert.equal(c.roomEpoch, 1, "epoch must come from actual signaling topology");
  assert.ok(app.trustedBroadcastSources.forPackager(c.consentId, f.packagerId, c.granteeDeviceRef));
  await until(() => nativeMessages.some(message => message.type === "trusted-source-prepare"));
  assert.deepEqual(nativeMessages.at(-1).lease, lease);
  assert.equal(browserMessages.some(message => message.type === "trusted-source-publisher-lease"), false);
  nativeSocket.send(JSON.stringify({ version: 1, type: "trusted-source-status", sourceLeaseId: lease.sourceLeaseId,
    leaseRevision: lease.revision, consentId: c.consentId, assignmentId: lease.assignmentId, fencingRevision: lease.fencingRevision,
    state: "receiver-prepared", expiresAt: lease.expiresAt, observedAt: Date.now() }));
  await until(() => nativeMessages.some(message => message.type === "trusted-source-prepare" && message.lease.revision === 2), () => ({
    leaseRemainingMs: lease.expiresAt - Date.now(), leaseAgeMs: Date.now() - lease.issuedAt,
    agentOpen: nativeSocket.readyState === WebSocket.OPEN, publisherOpen: socket.readyState === WebSocket.OPEN,
    prepareRevisions: nativeMessages.filter(m => m.type === "trusted-source-prepare").slice(-4).map(m => m.lease.revision),
    publisherLeaseCount: browserMessages.filter(m => m.type === "trusted-source-publisher-lease").length,
    nativeStopCount: nativeMessages.filter(m => m.type === "trusted-source-stop").length,
  }));
  await until(() => browserMessages.some(message => message.type === "trusted-source-publisher-lease"));
  assert.deepEqual(browserMessages.find(message => message.type === "trusted-source-publisher-lease").lease, lease);
  for (const message of nativeMessages.filter(message => message.type.startsWith("trusted-source-"))) assert.equal(validateControl(message), true);
  const offer = sourceSignal(lease);
  socket.send(JSON.stringify({ ...offer, description: { type: "offer", sdp: "\n".repeat(16384) } }));
  await until(() => browserMessages.some(message => message.type === "error"));
  assert.equal(nativeSocket.readyState, WebSocket.OPEN, "oversized escaped SDP must not close the target packager");
  assert.equal(nativeMessages.some(message => message.type === "trusted-source-peer-signal"), false);
  socket.send(JSON.stringify(offer));
  await until(() => nativeMessages.some(message => message.type === "trusted-source-peer-signal"));
  assert.deepEqual(nativeMessages.find(message => message.type === "trusted-source-peer-signal"), {
    ...offer, type: "trusted-source-peer-signal", publisherPeerId: actor.id,
  });
  const answer = sourceSignal(lease, false);
  nativeSocket.send(JSON.stringify(answer));
  await until(() => browserMessages.some(message => message.type === "trusted-source-agent-signal"));
  assert.deepEqual(browserMessages.find(message => message.type === "trusted-source-agent-signal"), {
    ...answer, type: "trusted-source-agent-signal", packagerId: f.packagerId, packagerDeviceRef: c.granteeDeviceRef,
  });
  socket.send(JSON.stringify(offer)); // Replay is an ordinary bounded source error.
  await until(() => browserMessages.some(message => message.type === "error" && message.code === "trusted_source_signal_unavailable"));
  // Stop/ACK here exercise real control WebSockets; the native receiver and
  // ciphertext path have separate Go/browser tests, not a media claim here.
  if (publicActions) {
    socket.send(JSON.stringify({ version: 1, type: "trusted-source-revoke", consentId: c.consentId }));
    await until(() => browserMessages.some(message => message.type === "trusted-source-revoked"));
    await until(() => browserMessages.some(message => message.type === "trusted-source-publisher-stop"));
    assert.equal(f.rooms.publication(joined.peerId, f.input.publicationId, f.input.roomId)?.publicationId, f.input.publicationId,
      "broadcast revoke does not stop the room's capture");
  }
  socket.send(JSON.stringify({ type: "media-state", source: "camera", active: false }));
  await until(() => app.trustedBroadcastSources.auditEvents().some(event => event.eventType === "consent-revoked"));
  await until(() => nativeMessages.some(message => message.type === "trusted-source-stop"));
  const stopped = nativeMessages.find(message => message.type === "trusted-source-stop");
  nativeSocket.send(JSON.stringify({ version: 1, type: "trusted-source-status", sourceLeaseId: stopped.sourceLeaseId,
    leaseRevision: stopped.leaseRevision, consentId: stopped.consentId, assignmentId: stopped.assignmentId,
    fencingRevision: stopped.fencingRevision, state: "stopped", expiresAt: stopped.expiresAt, observedAt: Date.now() }));
  socket.send(JSON.stringify({ type: "media-state", source: "camera", active: true, trackId: f.input.publicationId }));
  await until(() => f.rooms.publication(joined.peerId, f.input.publicationId, f.input.roomId)?.publicationEpoch === 2);
  assert.equal(app.trustedBroadcastSources.forPackager(c.consentId, f.packagerId, c.granteeDeviceRef), null);
  assert.equal(nativeSocket.readyState, WebSocket.OPEN);
  assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running");
});

test("publisher leases are delivered once per native ACK revision, never before it", () => {
  const f = sourceControlFixture(), first = f.prepare();
  assert.equal(f.publisherMessages.length, 0);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(first)), true);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(first)), true);
  assert.equal(f.publisherMessages.length, 1);
  assert.equal(f.publisherMessages[0].socket, f.publisher.socket);
  f.advance(1000); f.broker.tick(); const next = f.messages.at(-1).lease;
  assert.equal(f.publisherMessages.length, 1);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(first)), false);
  assert.equal(f.broker.acknowledge(f.socket, f.ack(next)), true);
  assert.equal(f.publisherMessages.length, 2);
  assert.equal(f.publisherMessages.at(-1).message.lease.revision, 2);
  f.grants.revoke(f.identity, f.input.deviceFingerprint, f.consent.consentId); f.broker.tick();
  assert.equal(f.publisherMessages.at(-1).message.type, "trusted-source-publisher-stop");
  assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running");
});

test("publisher delivery failure terminates the source without taking down the writer", () => {
  const f = sourceControlFixture(), lease = f.prepare(); f.failPublisher();
  assert.equal(f.broker.acknowledge(f.socket, f.ack(lease)), false);
  assert.equal(f.messages.at(-1).reasonCode, "PUBLISHER_DELIVERY_FAILED");
  assert.equal(f.assignments.activeForPackager(f.packagerId).state, "running");
  assert.throws(() => f.prepare(), /terminal/);
});

test("public source actions preserve actual connection, v4 opt-in and closed contracts", () => {
  const f = fixture(undefined, true);
  let prepared = 0, ticks = 0;
  const actions = new TrustedBroadcastSourceActions({ grants: f.grants,
    broker: { prepare: () => { prepared++; }, tick: () => { ticks++; } }, requests: f.requests,
    assignments: f.assignments, packagers: f.packagers, members: f.ports.members, membershipEpoch: f.ports.membershipEpoch });
  const message = { version: 1, type: "trusted-source-approve", approval: f.input };
  assert.equal(validateAction(message), true);
  assert.deepEqual(parseClientMessage(JSON.stringify(message)), message);
  for (const bad of [{ ...message, identity: f.identity }, { ...message, version: 2 },
    { ...message, approval: { ...f.input, key: "forbidden" } }]) {
    assert.equal(validateAction(bad), false); assert.throws(() => parseTrustedSourceAction(bad));
  }
  for (const actor of [{ ...f.publisher }, f.owner, { ...f.publisher, machine: true }]) {
    assert.throws(() => actions.execute(actor, f.identity, message));
  }
  assert.throws(() => actions.execute(f.publisher, f.ownerIdentity, message));
  assert.equal(prepared, 0);
  const query = { version: 1, type: "trusted-source-publications" };
  assert.equal(validateAction(query), true); assert.deepEqual(parseClientMessage(JSON.stringify(query)), query);
  assert.throws(() => actions.execute(f.publisher, f.identity, { ...query, peerId: f.owner.id }));
  const own = actions.execute(f.publisher, f.identity, query);
  assert.equal(validatePublisher(own), true); assert.equal(own.peerId, f.publisher.id);
  assert.equal(own.publications.length, 1); assert.equal(prepared, 0);
  const approved = actions.execute(f.publisher, f.identity, message);
  assert.equal(validatePublisher(approved), true); assert.equal(prepared, 1);
  const revoke = { version: 1, type: "trusted-source-revoke", consentId: approved.consent.consentId };
  assert.equal(validateAction(revoke), true); assert.deepEqual(parseClientMessage(JSON.stringify(revoke)), revoke);
  assert.throws(() => actions.execute(f.owner, f.ownerIdentity, revoke));
  assert.equal(validatePublisher(actions.execute(f.publisher, f.identity, revoke)), true);
  assert.equal(ticks, 1); assert.equal(f.lookup(approved.consent), null);
});

test("failed native preparation revokes approval and legacy writers never acquire public source consent", () => {
  for (const v4 of [true, false]) {
    const f = fixture(undefined, v4), actions = new TrustedBroadcastSourceActions({ grants: f.grants,
      broker: { prepare: () => { throw new Error("synthetic_prepare_failure"); }, tick() {} },
      requests: f.requests, assignments: f.assignments, packagers: f.packagers, members: f.ports.members,
      membershipEpoch: f.ports.membershipEpoch });
    assert.throws(() => actions.execute(f.publisher, f.identity, { version: 1, type: "trusted-source-approve", approval: f.input }),
      v4 ? /synthetic_prepare_failure/ : /program_unavailable/);
    assert.equal(f.grants.auditEvents().some(event => event.eventType === "consent-revoked"), v4);
  }
});
