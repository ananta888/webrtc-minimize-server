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

const validate = new Ajv({ strict: true }).compile(JSON.parse(await fs.readFile(
  new URL("../contracts/trusted-decrypt/wire.v1.schema.json", import.meta.url), "utf8")));
const validateApproval = new Ajv({ strict: true }).compile(JSON.parse(await fs.readFile(
  new URL("../contracts/trusted-decrypt/source-approval.v1.schema.json", import.meta.url), "utf8")));
function fixture(start = 1800000000000) {
  let now = start, epoch = 3;
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
  const capability = { capabilityVersion: 1, agentId: packagerId, tenantId: broadcastTenantRef(issuer),
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
  const prepared = runtime.prepareNativePublisher(ownerIdentity, owner, programId, { requestVersion: 1, trigger: "user-action",
    packagerId, sourceIds: ["src_aaaaaaaaaaaaaaaa"], requestedRenditions: 1, allowHardwareAcceleration: false }, request => request, now);
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
    publisher, packagers, packagerId, socket, refreshCapability, runtime, programId, requests, invite, ports, grants, input, approve, lookup,
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

test("live signaling lifecycle owns source generations and tears down internal consent on the stop message", { timeout: 10000 }, async t => {
  const f = fixture(Date.now()), keys = crypto.generateKeyPairSync("ed25519");
  f.rooms.leave(f.publisher);
  const config = { authMode: "required", oidcIssuer: f.identity.issuer, oidcAudience: "human", oidcAlgorithms: ["EdDSA"],
    publicOrigin: "https://synthetic-fixture.example", nativePackagerSelfServiceEnabled: true, stunUrls: [], turnServers: [] };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }) });
  const app = createAppServer({ config, oidcVerifier, registry: f.rooms, broadcastRuntime: f.runtime, nativePackagers: f.packagers,
    nativePackagerEnrollmentStore: { definitions: () => [] }, nativePackagerInstallerService: {} });
  let socket;
  t.after(async () => {
    socket?.terminate();
    for (const peer of app.webSocketServer.clients) peer.terminate();
    await new Promise(resolve => app.webSocketServer.close(resolve));
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.throws(() => app.trustedBroadcastSources.prune(), /closed/);
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // Explicit ephemeral session-policy fixture; this is not a PKCE/device-proof gate.
  const issued = app.ticketStore.issue({ origin: config.publicOrigin, roomId: f.input.roomId, mode: "room",
    name: "Synthetic source", authenticated: true, principal: oidcPrincipal(f.identity), deviceFingerprint: f.input.deviceFingerprint });
  socket = new WebSocket(`${base.replace("http:", "ws:")}/signal?ticket=${issued.ticket}`, { origin: config.publicOrigin });
  const welcome = new Promise(resolve => socket.on("message", raw => { const value = JSON.parse(raw); if (value.type === "welcome") resolve(value); }));
  await once(socket, "open"); const joined = await welcome;
  const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) { assert.ok(Date.now() < deadline, "bounded signaling observation expired"); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
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
  const c = app.trustedBroadcastSources.approve(f.identity, { ...f.input, requestId }, actor);
  assert.equal(c.roomEpoch, 1, "epoch must come from actual signaling topology");
  assert.ok(app.trustedBroadcastSources.forPackager(c.consentId, f.packagerId, c.granteeDeviceRef));
  socket.send(JSON.stringify({ type: "media-state", source: "camera", active: false }));
  await until(() => app.trustedBroadcastSources.auditEvents().some(event => event.eventType === "consent-revoked"));
  socket.send(JSON.stringify({ type: "media-state", source: "camera", active: true, trackId: f.input.publicationId }));
  await until(() => f.rooms.publication(joined.peerId, f.input.publicationId, f.input.roomId)?.publicationEpoch === 2);
  assert.equal(app.trustedBroadcastSources.forPackager(c.consentId, f.packagerId, c.granteeDeviceRef), null);
});
