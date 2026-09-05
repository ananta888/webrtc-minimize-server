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
});

test("only the owner can change visibility or stop and each action updates directory access", () => {
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
  const visible = runtime.changeVisibility(owner, "prg_eeeeeeeeeeeeeeee", {
    requestVersion: 1,
    visibility: "public",
  }, NOW + 1);
  assert.equal(visible.visibility, "public");
  assert.equal(visible.playback, "public");
  assert.equal(runtime.listPublic(broadcastTenantRef(ISSUER)).length, 1);

  const stopped = runtime.stopProgram(owner, "prg_eeeeeeeeeeeeeeee", NOW + 2);
  assert.equal(stopped.availability, "ended");
  assert.equal(runtime.listPublic(broadcastTenantRef(ISSUER)).length, 0);
  assert.equal(runtime.stopProgram(owner, "prg_eeeeeeeeeeeeeeee", NOW + 3).availability, "ended");
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
  assert.throws(() => runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision + 1, NOW + 1,
  ), /stale_broadcast_packager_output/);
  const live = runtime.markNativeOutputReady(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 1,
  );
  assert.equal(live.availability, "live");
  const renewed = runtime.renewNativeOutput(
    "res_hhhhhhhhhhhhhhhh", packagerId, prepared.lease.fencingRevision, NOW + 90_000, NOW + 30_000,
  );
  assert.equal(renewed.availability, "live");
  assert.throws(() => runtime.renewNativeOutput(
    "res_hhhhhhhhhhhhhhhh", "pkr_xxxxxxxxxxxxxxxx", prepared.lease.fencingRevision,
    NOW + 120_000, NOW + 60_000,
  ), /stale_broadcast_lease_renewal/);
});
