import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { broadcastGrantDeviceProofMessage } from "../src/broadcast-device-proof.js";
import { BroadcastGrantAuthority } from "../src/broadcast-grant-authority.js";
import { BroadcastRuntimeError, BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { broadcastSubjectRef, broadcastTenantRef } from "../src/broadcast-identifiers.js";
import { deviceFingerprint } from "../src/device-proof.js";
import { MediaMtxExternalAuthService } from "../src/mediamtx-external-auth.js";

const NOW = 1_800_000_000_000;
const ISSUER = "https://identity.example/realms/ananta";

function authority() {
  const signing = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return new BroadcastGrantAuthority({
    issuer: "https://webrtc.example/broadcast-grants",
    oidcIssuer: ISSUER,
    oidcAudience: "webrtc-room-server",
    oidcAlgorithms: ["RS256"],
    signingKeys: [{ kid: "runtime-test", ...signing }],
  });
}

function identity(subject, displayName) {
  return Object.freeze({
    issuer: ISSUER,
    subject,
    audience: "webrtc-room-server",
    algorithm: "RS256",
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 300_000,
    displayName,
  });
}

function registration(owner, suffix, visibility = "private", viewers = [], anonymous = false) {
  const tenantId = broadcastTenantRef(owner.issuer);
  const ownerSubjectRef = broadcastSubjectRef(owner);
  const programId = `prg_${suffix.repeat(16)}`;
  const policyId = `pol_${suffix.repeat(16)}`;
  const roomId = `room-${suffix}`;
  return {
    machine: {
      machineVersion: 1,
      scope: { tenantId, ownerSubjectRef, roomId, programId },
      epochs: { membership: 1, route: 1, topology: 1, broadcast: 1, lease: 1 },
      program: {
        contractVersion: 1,
        type: "broadcast-program",
        tenantId,
        ownerSubjectRef,
        roomId,
        programId,
        revision: 1,
        programEpoch: 1,
        state: "live",
        visibility,
        title: `Programm ${suffix.toUpperCase()}`,
        viewerPolicyId: policyId,
        createdAt: NOW - 20_000,
        updatedAt: NOW - 1_000,
      },
      writerLeases: [],
      appliedCommands: [],
    },
    policy: {
      contractVersion: 1,
      type: "viewer-policy",
      tenantId,
      ownerSubjectRef,
      roomId,
      programId,
      policyId,
      revision: 1,
      programEpoch: 1,
      visibility,
      authentication: anonymous ? "none" : "required",
      directoryListed: visibility === "public",
      anonymousAllowed: anonymous,
      allowedOriginHashes: [],
      updatedAt: NOW - 1_000,
    },
    authorizedViewerSubjectRefs: viewers,
    resourceRef: `res_${suffix.repeat(16)}`,
    ownerLabel: owner.displayName,
    ownerVisibility: "shown",
    latencyMode: "ll-hls",
    captions: true,
    viewerCount: 0,
  };
}

function proof(device, context) {
  const timestamp = NOW;
  const nonce = crypto.randomBytes(24).toString("base64url");
  return {
    publicKey: device.publicKey.export({ format: "jwk" }),
    timestamp,
    nonce,
    signature: crypto.sign(
      "sha256",
      Buffer.from(broadcastGrantDeviceProofMessage(context, timestamp, nonce)),
      { key: device.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url"),
  };
}

test("runtime projects public, owned and explicitly authorized programs without room membership", async () => {
  const owner = identity("owner", "Ada");
  const viewer = identity("viewer", "Grace");
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: authority(), clock: () => NOW });
  runtime.register(registration(owner, "a", "public"), NOW);
  runtime.register(registration(owner, "b", "private", [broadcastSubjectRef(viewer)]), NOW);

  assert.deepEqual(runtime.listPublic(broadcastTenantRef(ISSUER)).map(({ programId }) => programId), [
    "prg_aaaaaaaaaaaaaaaa",
  ]);
  const ownerList = runtime.listMine(owner);
  assert.equal(ownerList.owned.length, 2);
  assert.equal(ownerList.authorized.length, 0);
  const viewerList = runtime.listMine(viewer);
  assert.equal(viewerList.owned.length, 0);
  assert.deepEqual(viewerList.authorized.map(({ programId }) => programId), ["prg_bbbbbbbbbbbbbbbb"]);
  assert.equal(JSON.stringify(runtime.listPublic(broadcastTenantRef(ISSUER))).includes("roomId"), false);
});

test("playback uses a one-time device-bound challenge and does not create room membership", async () => {
  const owner = identity("owner", "Ada");
  const viewer = identity("viewer", "Grace");
  const grantAuthority = authority();
  let challengeSequence = 0;
  const runtime = new BroadcastRuntimeRegistry({
    grantAuthority,
    clock: () => NOW,
    idFactory: () => `bpc_${String(++challengeSequence).padStart(24, "a")}`,
  });
  const registered = runtime.register(registration(
    owner,
    "b",
    "private",
    [broadcastSubjectRef(viewer)],
  ), NOW);
  const challenge = await runtime.createPlaybackChallenge(viewer, registered.programId, NOW);
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bootstrap = await runtime.authorizePlayback(viewer, {
    requestVersion: 1,
    challengeId: challenge.challengeId,
    deviceProof: proof(device, challenge.proofContext),
  }, NOW);

  assert.equal(bootstrap.program.programId, registered.programId);
  assert.equal(bootstrap.resourceRef, "res_bbbbbbbbbbbbbbbb");
  assert.match(bootstrap.playbackGrant, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(runtime.challengeCount, 0);
  await assert.rejects(
    () => runtime.authorizePlayback(viewer, {
      requestVersion: 1,
      challengeId: challenge.challengeId,
      deviceProof: proof(device, challenge.proofContext),
    }, NOW),
    (error) => error?.code === "broadcast_not_available",
  );
});

test("public anonymous playback remains device-, policy- and epoch-bound without OIDC", async () => {
  const owner = identity("owner", "Ada");
  const grantAuthority = authority();
  const runtime = new BroadcastRuntimeRegistry({
    grantAuthority,
    clock: () => NOW,
    idFactory: () => `bpc_${"a".repeat(24)}`,
    anonymousSubjectFactory: () => `sub_${"z".repeat(24)}`,
  });
  const registered = runtime.register(registration(owner, "c", "public", [], true), NOW);
  const challenge = await runtime.createPlaybackChallenge(null, registered.programId, NOW, {
    tenantId: broadcastTenantRef(ISSUER),
  });
  assert.equal(challenge.proofContext.subjectRef, `sub_${"z".repeat(24)}`);
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bootstrap = await runtime.authorizePlayback(null, {
    requestVersion: 1,
    challengeId: challenge.challengeId,
    deviceProof: proof(device, challenge.proofContext),
  }, NOW);
  assert.equal(bootstrap.program.playback, "public");
  assert.match(bootstrap.playbackGrant, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(runtime.challengeCount, 0);
  await assert.rejects(
    () => runtime.authorizePlayback(null, {
      requestVersion: 1,
      challengeId: challenge.challengeId,
      deviceProof: proof(device, challenge.proofContext),
    }, NOW),
    (error) => error?.code === "broadcast_not_available",
  );

  const privateProgram = runtime.register(registration(owner, "d", "private"), NOW);
  await assert.rejects(
    () => runtime.createPlaybackChallenge(null, privateProgram.programId, NOW, {
      tenantId: broadcastTenantRef(ISSUER),
    }),
    (error) => error?.code === "broadcast_not_available",
  );
});

test("private programs are non-enumerable to unrelated identities", async () => {
  const owner = identity("owner", "Ada");
  const unrelated = identity("other", "Linus");
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: authority(), clock: () => NOW });
  runtime.register(registration(owner, "c", "private"), NOW);
  await assert.rejects(
    () => runtime.createPlaybackChallenge(unrelated, "prg_cccccccccccccccc", NOW),
    (error) => error.code === "broadcast_not_available" && error.status === 404,
  );
  await assert.rejects(
    () => runtime.createPlaybackChallenge(unrelated, "prg_zzzzzzzzzzzzzzzz", NOW),
    (error) => error.code === "broadcast_not_available" && error.status === 404,
  );
});

test("owner creates a draft, obtains a device-bound publisher grant and becomes live only after gateway auth", async () => {
  const owner = identity("owner", "Ada");
  const grantAuthority = authority();
  let challengeSequence = 0;
  const runtime = new BroadcastRuntimeRegistry({
    grantAuthority,
    clock: () => NOW,
    idFactory: () => `bpc_${String(++challengeSequence).padStart(24, "a")}`,
    programIdFactory: () => "prg_dddddddddddddddd",
    policyIdFactory: () => "pol_dddddddddddddddd",
    resourceIdFactory: () => "res_dddddddddddddddd",
  });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fingerprint = deviceFingerprint(device.publicKey.export({ format: "jwk" }));
  const member = {
    principal: `${owner.issuer}|${owner.subject}`,
    roomId: "room-alpha",
    creator: true,
    deviceFingerprint: fingerprint,
  };
  const created = runtime.createProgram(owner, member, {
    requestVersion: 1,
    roomId: "room-alpha",
    title: "Öffentlicher Pilot",
    visibility: "public",
  }, NOW);
  assert.equal(created.program.availability, "offline");
  assert.equal(runtime.programStateCounts().draft, 1);
  assert.deepEqual(runtime.listPublic(broadcastTenantRef(ISSUER)), []);

  const challenge = runtime.createPublisherChallenge(owner, member, created.program.programId, {
    requestVersion: 1,
    action: "whip:create",
    sourceIds: ["src_aaaaaaaaaaaaaaaa"],
  }, NOW);
  const authorization = await runtime.authorizePublisher(owner, {
    requestVersion: 1,
    challengeId: challenge.challengeId,
    deviceProof: proof(device, challenge.proofContext),
  }, NOW);
  assert.equal(authorization.action, "whip:create");
  assert.equal(authorization.program.programEpoch, 2);
  assert.equal(runtime.programStateCounts().draft, 0);
  assert.equal(runtime.programStateCounts().preparing, 1);
  assert.deepEqual(runtime.listPublic(broadcastTenantRef(ISSUER)), []);

  const gateway = new MediaMtxExternalAuthService({
    authority: grantAuthority,
    now: () => NOW,
    onAuthorized: ({ request, now }) => runtime.markPublished(request.path, now),
  });
  await gateway.authorize({
    user: "",
    password: "",
    token: authorization.accessToken,
    ip: "127.0.0.1",
    action: "publish",
    path: authorization.resourceRef,
    protocol: "webrtc",
    id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    query: "",
    userAgent: "MediaMTX/1.20.1",
  });
  const visible = runtime.listPublic(broadcastTenantRef(ISSUER));
  assert.equal(visible.length, 1);
  assert.equal(visible[0].availability, "live");
  assert.equal(runtime.programStateCounts().preparing, 0);
  assert.equal(runtime.programStateCounts().live, 1);
});

test("visibility changes require a fenced stop and remain owner-only", () => {
  const owner = identity("owner", "Ada");
  const other = identity("other", "Grace");
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: authority(), clock: () => NOW });
  runtime.register(registration(owner, "e", "private"), NOW);

  assert.throws(
    () => runtime.changeVisibility(other, "prg_eeeeeeeeeeeeeeee", {
      requestVersion: 1,
      visibility: "public",
    }, NOW),
    (error) => error instanceof BroadcastRuntimeError && error.code === "broadcast_not_available",
  );
  assert.throws(
    () => runtime.changeVisibility(owner, "prg_eeeeeeeeeeeeeeee", {
      requestVersion: 1,
      visibility: "public",
    }, NOW + 1),
    (error) => error instanceof BroadcastRuntimeError && error.code === "broadcast_visibility_restart_required",
  );
  const stopped = runtime.stopProgram(owner, "prg_eeeeeeeeeeeeeeee", NOW + 2);
  assert.equal(stopped.availability, "ended");
  const visible = runtime.changeVisibility(owner, "prg_eeeeeeeeeeeeeeee", {
    requestVersion: 1,
    visibility: "public",
  }, NOW + 3);
  assert.equal(visible.visibility, "public");
  assert.equal(visible.playback, "public");
  assert.equal(visible.availability, "ended");
  assert.equal(runtime.listPublic(broadcastTenantRef(ISSUER)).length, 0);
  assert.equal(runtime.stopProgram(owner, "prg_eeeeeeeeeeeeeeee", NOW + 4).availability, "ended");
});

test("publisher device departure stops only programs bound to that room device", async () => {
  const owner = identity("owner", "Ada");
  const runtime = new BroadcastRuntimeRegistry({
    grantAuthority: authority(),
    clock: () => NOW,
    idFactory: () => `bpc_${"f".repeat(24)}`,
    programIdFactory: () => "prg_ffffffffffffffff",
    policyIdFactory: () => "pol_ffffffffffffffff",
    resourceIdFactory: () => "res_ffffffffffffffff",
  });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const member = {
    principal: `${owner.issuer}|${owner.subject}`,
    roomId: "room-alpha",
    creator: true,
    deviceFingerprint: deviceFingerprint(device.publicKey.export({ format: "jwk" })),
  };
  const created = runtime.createProgram(owner, member, {
    requestVersion: 1,
    roomId: member.roomId,
    title: "Gebundene Sendung",
    visibility: "private",
  }, NOW);
  const challenge = runtime.createPublisherChallenge(owner, member, created.control.programId, {
    requestVersion: 1,
    action: "whip:create",
    sourceIds: ["src_ffffffffffffffff"],
  }, NOW);
  await runtime.authorizePublisher(owner, {
    requestVersion: 1,
    challengeId: challenge.challengeId,
    deviceProof: proof(device, challenge.proofContext),
  }, NOW);

  assert.equal(runtime.stopProgramsForMember({ ...member, deviceFingerprint: "x".repeat(43) }, NOW), 0);
  assert.equal(runtime.stopProgramsForMember(member, NOW + 1), 1);
  assert.equal(runtime.listMine(owner).owned[0].availability, "ended");
  assert.equal(runtime.stopProgramsForMember(member, NOW + 2), 0);
});

for (const change of ["stop", "leave", "native-start", "expiry", "clock-rollback", "clock-invalid", "clock-failed"]) {
  test(`pending publisher grant cannot commit across ${change}`, { timeout: 5000 }, async () => {
    const owner = identity("owner", "Ada"), grants = authority();
    let now = NOW, release;
    const issued = [];
    const gate = new Promise(resolve => { release = resolve; });
    const runtime = new BroadcastRuntimeRegistry({ clock: () => {
      if (now === "throw") throw new Error("synthetic_clock_failure");
      return now;
    }, grantAuthority: {
      issue: async (...args) => { const result = await grants.issue(...args); issued.push(result); await gate; return result; },
      issueAnonymousPlayback: (...args) => grants.issueAnonymousPlayback(...args),
      revokeGrant: (...args) => grants.revokeGrant(...args),
      revokeProgramEpoch: (...args) => grants.revokeProgramEpoch(...args),
    } });
    const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const member = { principal: `${owner.issuer}|${owner.subject}`, roomId: "room-alpha", creator: true,
      deviceFingerprint: deviceFingerprint(device.publicKey.export({ format: "jwk" })) };
    const created = runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
      title: "Synthetic transaction", visibility: "private" });
    const programId = created.control.programId;
    const challenge = runtime.createPublisherChallenge(owner, member, programId, {
      requestVersion: 1, action: "whip:create", sourceIds: ["src_aaaaaaaaaaaaaaaa"] });
    const pending = runtime.authorizePublisher(owner, { requestVersion: 1, challengeId: challenge.challengeId,
      deviceProof: proof(device, challenge.proofContext) });
    // The real crypto authority has issued a JWT before its delivery is delayed.
    while (!issued.length) await new Promise(resolve => setImmediate(resolve));
    if (change === "stop") runtime.stopProgram(owner, programId);
    if (change === "leave") runtime.stopProgramsForMember(member);
    if (change === "expiry") now = challenge.expiresAt;
    if (change === "clock-rollback") now--;
    if (change === "clock-invalid") now = NaN;
    if (change === "clock-failed") now = "throw";
    let native;
    if (change === "native-start") native = runtime.prepareNativeSourceProgram(owner, member, programId, {
      requestVersion: 1, trigger: "user-action", inputMode: "trusted-sframe-v1",
      packagerId: "pkr_aaaaaaaaaaaaaaaa", requestedRenditions: 1, allowHardwareAcceleration: false,
    }, () => ({ admissionVersion: 1 }));
    release();
    await assert.rejects(pending, error => error.code === "broadcast_not_available");
    assert.equal(runtime.programStateCounts().preparing, native ? 1 : 0);
    if (change === "stop") assert.equal(runtime.listMine(owner).owned[0].availability, "ended");
    await assert.rejects(grants.authorizeGatewayBearer(`Bearer ${issued[0].token}`, {
      action: "whip:create", grantKinds: ["publisher"], path: `/broadcast/ingest/${issued[0].grant.resourceRef}`,
    }, NOW + 1), error => error.code === "inactive_broadcast_grant" || error.code === "revoked_broadcast_program_epoch");
  });
}

test("pending publisher timeout releases its transaction, rejects concurrent signing and revokes a late JWT", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const owner = identity("owner", "Ada"), grants = authority();
  let release, notifyIssued, calls = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { notifyIssued = resolve; });
  const runtime = new BroadcastRuntimeRegistry({ clock: () => NOW, grantAuthority: {
    issue: async (...args) => {
      calls++; const issued = await grants.issue(...args);
      if (calls === 1) { notifyIssued(issued); await delayed; }
      return issued;
    },
    issueAnonymousPlayback: (...args) => grants.issueAnonymousPlayback(...args),
    revokeGrant: (...args) => grants.revokeGrant(...args),
    revokeProgramEpoch: (...args) => grants.revokeProgramEpoch(...args),
  } });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const member = { id: "aaaaaaaaaaaaaaaa", principal: `${owner.issuer}|${owner.subject}`,
    roomId: "room-alpha", creator: true, deviceFingerprint: deviceFingerprint(device.publicKey.export({ format: "jwk" })) };
  const programId = runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
    title: "Synthetic timeout", visibility: "private" }).control.programId;
  const start = () => {
    const challenge = runtime.createPublisherChallenge(owner, member, programId, {
      requestVersion: 1, action: "whip:create", sourceIds: ["src_aaaaaaaaaaaaaaaa"] });
    return runtime.authorizePublisher(owner, { requestVersion: 1, challengeId: challenge.challengeId,
      deviceProof: proof(device, challenge.proofContext) });
  };
  const pending = start(), late = await ready;
  await assert.rejects(start(), error => error.code === "broadcast_publisher_authorization_pending" && error.status === 409);
  assert.equal(calls, 1);
  // Another device/room/peer departure is not this transaction's membership.
  for (const patch of [{ deviceFingerprint: "z".repeat(43) }, { roomId: "room-other" }, { id: "bbbbbbbbbbbbbbbb" }]) {
    runtime.stopProgramsForMember({ ...member, ...patch });
  }
  t.mock.timers.tick(4999);
  await assert.rejects(start(), error => error.code === "broadcast_publisher_authorization_pending");
  const rejected = assert.rejects(pending, error => error.code === "broadcast_not_available");
  t.mock.timers.tick(1); await rejected;
  assert.equal(runtime.programStateCounts().preparing, 0);
  // Reuse the released slot before the obsolete issuer cooperates.
  const successor = await start(); assert.equal(calls, 2);
  assert.equal(runtime.programStateCounts().preparing, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(grants.authorizeGatewayBearer(`Bearer ${late.token}`, { action: "whip:create",
    grantKinds: ["publisher"], path: `/broadcast/ingest/${late.grant.resourceRef}` }, NOW + 1),
  error => error.code === "inactive_broadcast_grant");
  const allowed = await grants.authorizeGatewayBearer(`Bearer ${successor.accessToken}`, { action: "whip:create",
    grantKinds: ["publisher"], path: `/broadcast/ingest/${successor.resourceRef}` }, NOW + 1);
  assert.equal(allowed.status, "consumed");
});

test("departure invalidates an unredeemed publisher challenge before crypto issuance", async () => {
  const owner = identity("owner", "Ada"), grants = authority();
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: grants, clock: () => NOW });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const member = { principal: `${owner.issuer}|${owner.subject}`, roomId: "room-alpha", creator: true,
    deviceFingerprint: deviceFingerprint(device.publicKey.export({ format: "jwk" })) };
  const programId = runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
    title: "Synthetic departure", visibility: "private" }).control.programId;
  const challenge = runtime.createPublisherChallenge(owner, member, programId, {
    requestVersion: 1, action: "whip:create", sourceIds: ["src_aaaaaaaaaaaaaaaa"] });
  runtime.stopProgramsForMember(member);
  assert.equal(runtime.challengeCount, 0);
  await assert.rejects(runtime.authorizePublisher(owner, { requestVersion: 1, challengeId: challenge.challengeId,
    deviceProof: proof(device, challenge.proofContext) }), error => error.code === "broadcast_not_available");
  assert.equal(runtime.programStateCounts().preparing, 0);
});

test("native publisher preparation commits only after bounded admission and installs the real packager lease", () => {
  const owner = identity("owner", "Ada");
  const runtime = new BroadcastRuntimeRegistry({
    grantAuthority: authority(),
    clock: () => NOW,
    programIdFactory: () => "prg_gggggggggggggggg",
    policyIdFactory: () => "pol_gggggggggggggggg",
    resourceIdFactory: () => "res_gggggggggggggggg",
    leaseIdFactory: () => "lea_gggggggggggggggg",
  });
  const member = {
    principal: `${owner.issuer}|${owner.subject}`,
    roomId: "room-alpha",
    creator: true,
    deviceFingerprint: "a".repeat(43),
  };
  const created = runtime.createProgram(owner, member, {
    requestVersion: 1, roomId: member.roomId, title: "Native", visibility: "private",
  }, NOW);
  let admitted;
  assert.throws(() => runtime.prepareNativePublisher(owner, member, created.control.programId, {
    requestVersion: 1, trigger: "user-action", packagerId: "pkr_gggggggggggggggg",
    sourceIds: ["src_gggggggggggggggg"], requestedRenditions: 2, allowHardwareAcceleration: false,
  }, () => { throw new Error("capacity_denied"); }, NOW), /capacity_denied/);
  assert.equal(runtime.listMine(owner).owned[0].availability, "offline");

  const prepared = runtime.prepareNativePublisher(owner, member, created.control.programId, {
    requestVersion: 1, trigger: "user-action", packagerId: "pkr_gggggggggggggggg",
    sourceIds: ["src_gggggggggggggggg"], requestedRenditions: 2, allowHardwareAcceleration: false,
  }, (request) => {
    admitted = request;
    return Object.freeze({
      admissionVersion: 1, agentId: "pkr_gggggggggggggggg", roomId: request.roomId,
      programId: request.programId, programEpoch: request.programEpoch, resourceRef: request.resourceRef,
      videoEncoder: "libx264", softwareFallback: "libx264", audioEncoder: "aac",
      profileId: "h264-aac-720p-v1", renditions: Object.freeze([]), maximumQueueFrames: 60,
      keyframeIntervalSeconds: 2,
    });
  }, NOW);
  assert.equal(admitted.programEpoch, 2);
  assert.equal(prepared.program.programEpoch, 2);
  assert.equal(prepared.lease.leaseId, "lea_gggggggggggggggg");
  assert.equal(prepared.lease.fencingRevision, 3);
  assert.equal(runtime.listMine(owner).owned[0].availability, "offline");
  assert.throws(() => runtime.prepareNativePublisher(owner, member, created.control.programId, {
    requestVersion: 1, trigger: "user-action", packagerId: "pkr_gggggggggggggggg",
    sourceIds: ["src_gggggggggggggggg"], requestedRenditions: 2, allowHardwareAcceleration: false,
  }, () => ({}), NOW), /already_started/);
});

test("native output becomes live only for the assigned fresh writer fence", () => {
  const owner = identity("owner", "Ada");
  const runtime = new BroadcastRuntimeRegistry({
    grantAuthority: authority(), clock: () => NOW,
    programIdFactory: () => "prg_hhhhhhhhhhhhhhhh",
    policyIdFactory: () => "pol_hhhhhhhhhhhhhhhh",
    resourceIdFactory: () => "res_hhhhhhhhhhhhhhhh",
    leaseIdFactory: () => "lea_hhhhhhhhhhhhhhhh",
  });
  const member = {
    principal: `${owner.issuer}|${owner.subject}`, roomId: "room-alpha", creator: true,
    deviceFingerprint: "a".repeat(43),
  };
  const created = runtime.createProgram(owner, member, {
    requestVersion: 1, roomId: member.roomId, title: "Native", visibility: "private",
  }, NOW);
  const packagerId = "pkr_hhhhhhhhhhhhhhhh";
  const prepared = runtime.prepareNativePublisher(owner, member, created.control.programId, {
    requestVersion: 1, trigger: "user-action", packagerId,
    sourceIds: ["src_hhhhhhhhhhhhhhhh"], requestedRenditions: 2, allowHardwareAcceleration: false,
  }, (request) => ({
    admissionVersion: 1, agentId: packagerId, roomId: request.roomId,
    programId: request.programId, programEpoch: request.programEpoch, resourceRef: request.resourceRef,
    videoEncoder: "libx264", softwareFallback: "libx264", audioEncoder: "aac",
    profileId: "h264-aac-720p-v1", renditions: [], maximumQueueFrames: 60,
    keyframeIntervalSeconds: 2,
  }), NOW);
  const beforeReady = runtime.listMine(owner);
  for (const [holder, fence, observedAt] of [
    ["pkr_xxxxxxxxxxxxxxxx", prepared.lease.fencingRevision, NOW + 1],
    [packagerId, prepared.lease.fencingRevision + 1, NOW + 1],
    [packagerId, prepared.lease.fencingRevision, prepared.lease.expiresAt],
  ]) {
    assert.throws(() => runtime.markNativeOutputReady(
      "res_hhhhhhhhhhhhhhhh", holder, fence, observedAt,
    ), /stale_broadcast_packager_output/);
    assert.deepEqual(runtime.listMine(owner), beforeReady);
  }
  assert.throws(() => runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision + 1, NOW + 1,
  ), /stale_broadcast_packager_output/);
  const live = runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 1,
  );
  assert.equal(live.availability, "live");
  const afterReady = runtime.listMine(owner);
  assert.deepEqual(runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 2,
  ), live);
  for (const [holder, fence, observedAt] of [
    ["pkr_xxxxxxxxxxxxxxxx", prepared.lease.fencingRevision, NOW + 2],
    [packagerId, prepared.lease.fencingRevision + 1, NOW + 2],
    [packagerId, prepared.lease.fencingRevision, prepared.lease.expiresAt],
  ]) {
    assert.throws(() => runtime.markNativeOutputReady(
      "res_hhhhhhhhhhhhhhhh", holder, fence, observedAt,
    ), /stale_broadcast_packager_output/);
    assert.deepEqual(runtime.listMine(owner), afterReady);
  }
  for (const [holder, fence, observedAt] of [
    ["pkr_xxxxxxxxxxxxxxxx", prepared.lease.fencingRevision, NOW + 2],
    [packagerId, prepared.lease.fencingRevision + 1, NOW + 2],
    [packagerId, prepared.lease.fencingRevision, prepared.lease.expiresAt],
  ]) {
    assert.throws(() => runtime.markNativeOutputUnavailable(
      "res_hhhhhhhhhhhhhhhh", holder, fence, observedAt,
    ), /stale_broadcast_packager_output/);
    assert.deepEqual(runtime.listMine(owner), afterReady);
  }
  const degraded = runtime.markNativeOutputUnavailable(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 2,
  );
  assert.deepEqual(degraded, { ...live, availability: "degraded" });
  assert.deepEqual(runtime.markNativeOutputUnavailable(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 3,
  ), degraded);
  assert.deepEqual(runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 3,
  ), live, "same writer recovers without changing public epoch, policy or resource");
  const renewed = runtime.renewNativeOutput(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 90_000, NOW + 30_000,
  );
  assert.equal(renewed.availability, "live");
  assert.deepEqual(runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 60_000,
  ), renewed);
  assert.throws(() => runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 90_000,
  ), /stale_broadcast_packager_output/);
  assert.throws(() => runtime.renewNativeOutput(
    "res_hhhhhhhhhhhhhhhh", "pkr_xxxxxxxxxxxxxxxx", prepared.lease.fencingRevision,
    NOW + 120_000, NOW + 60_000,
  ), /stale_broadcast_lease_renewal/);
});

test("a live native output ACK without a writer cannot claim success", () => {
  const owner = identity("owner", "Ada");
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: authority(), clock: () => NOW });
  runtime.register(registration(owner, "a"), NOW);
  const before = runtime.listMine(owner);
  assert.throws(() => runtime.markNativeOutputReady(
    "res_aaaaaaaaaaaaaaaa", "pkr_aaaaaaaaaaaaaaaa", 1, NOW + 1,
  ), /stale_broadcast_packager_output/);
  assert.deepEqual(runtime.listMine(owner), before);
});

test("same-program native output restart invalidates a real signed playback grant before successor activation", async () => {
  const owner = identity("owner", "Ada");
  const grants = authority();
  let issued;
  const issue = grants.issue.bind(grants);
  grants.issue = async (...args) => { issued = await issue(...args); return issued; };
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: grants, clock: () => NOW });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const member = { principal: `${owner.issuer}|${owner.subject}`, roomId: "room-alpha", creator: true,
    id: "0123456789abcdef", deviceFingerprint: deviceFingerprint(device.publicKey.export({ format: "jwk" })) };
  const created = runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
    title: "Unchanged", visibility: "private" }, NOW);
  const programId = created.control.programId, packagerId = "pkr_aaaaaaaaaaaaaaaa";
  const prepared = runtime.prepareNativePublisher(owner, member, programId, { requestVersion: 1,
    trigger: "user-action", packagerId, sourceIds: ["src_aaaaaaaaaaaaaaaa"], requestedRenditions: 2,
    allowHardwareAcceleration: false }, request => request, NOW);
  runtime.markNativeOutputReady(prepared.admission.resourceRef, packagerId, prepared.lease.fencingRevision, NOW);
  const challenge = await runtime.createPlaybackChallenge(owner, programId, NOW);
  const bootstrap = await runtime.authorizePlayback(owner, { requestVersion: 1, challengeId: challenge.challengeId,
    deviceProof: proof(device, challenge.proofContext) }, NOW);
  const grant = issued.grant;
  const expectation = { audience: grant.tokenAudience, action: "playback:manifest", tenantId: grant.tenantId,
    subjectRef: broadcastSubjectRef(owner), audienceRef: grant.audienceRef, deviceRef: grant.deviceRef,
    roomId: grant.roomId, programId, programRevision: challenge.proofContext.programRevision,
    programEpoch: grant.programEpoch, resourceRef: grant.resourceRef, policyId: grant.policyId,
    policyRevision: grant.policyRevision, path: `/broadcast/play/${grant.resourceRef}/index.m3u8` };
  await grants.authorizeBearer(`Bearer ${bootstrap.playbackGrant}`, expectation, NOW);
  const control = runtime.nativeControl(owner, member, programId);
  const pending = runtime.beginNativeHandoff(owner, member, programId, { requestVersion: 1, trigger: "user-action",
    packagerId: "pkr_bbbbbbbbbbbbbbbb", expectedProgramRevision: control.programRevision,
    expectedProgramEpoch: control.programEpoch, expectedFencingRevision: control.writer.fencingRevision,
    requestedRenditions: 2, allowHardwareAcceleration: false }, request => request, NOW + 1);
  await assert.rejects(grants.authorizeBearer(`Bearer ${bootstrap.playbackGrant}`, expectation, NOW + 2), /revoked_broadcast_program_epoch/);
  assert.equal(runtime.programCount, 1);
  assert.equal(runtime.listMine(owner).owned[0].visibility, "private");
  assert.equal(runtime.listMine(owner).owned[0].availability, "offline");
  runtime.cancelNativeHandoff(owner, pending, NOW + 2);
});
