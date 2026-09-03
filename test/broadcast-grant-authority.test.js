import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BroadcastDeviceProofVerifier,
  broadcastGrantDeviceProofMessage,
} from "../src/broadcast-device-proof.js";
import {
  BroadcastGrantAuthority,
  BroadcastGrantError,
  broadcastGrantPathHash,
} from "../src/broadcast-grant-authority.js";
import {
  broadcastSubjectRef,
  broadcastTenantRef,
  oidcPrincipal,
} from "../src/broadcast-identifiers.js";
import { deviceFingerprint } from "../src/device-proof.js";

const NOW = 1_800_000_000_000;
const ISSUER = "https://identity.test/realms/ananta";
const OIDC_AUDIENCE = "webrtc-room-server";
const ROOM_ID = "room-alpha";
const PROGRAM_ID = "prg_aaaaaaaaaaaaaaaa";
const RESOURCE_REF = "res_aaaaaaaaaaaaaaaa";
const POLICY_ID = "pol_aaaaaaaaaaaaaaaa";

const errorCode = (code) => (error) => error instanceof BroadcastGrantError && error.code === code;

function signingKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { kid, privateKey, publicKey };
}

function device() {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "jwk" });
  return { ...keys, publicKey, fingerprint: deviceFingerprint(publicKey) };
}

function baseFixture(overrides = {}) {
  const identity = {
    issuer: ISSUER,
    subject: "user-123",
    audience: OIDC_AUDIENCE,
    algorithm: "RS256",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 300_000,
    displayName: "Ada",
    ...overrides.identity,
  };
  const tenantId = broadcastTenantRef(identity.issuer);
  const subjectRef = broadcastSubjectRef(identity);
  const actorDevice = overrides.actorDevice || device();
  const audienceRef = overrides.audienceRef || subjectRef;
  const granteeDevice = overrides.granteeDevice || actorDevice;
  const program = {
    contractVersion: 1,
    type: "broadcast-program",
    tenantId,
    ownerSubjectRef: subjectRef,
    roomId: ROOM_ID,
    programId: PROGRAM_ID,
    revision: 4,
    programEpoch: 7,
    state: "publishing",
    visibility: "private",
    sourceIds: [],
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...overrides.program,
  };
  const membership = {
    active: true,
    tenantId,
    roomId: ROOM_ID,
    subjectRef,
    principal: oidcPrincipal(identity),
    role: "owner",
    deviceFingerprint: actorDevice.fingerprint,
    ...overrides.membership,
  };
  const grantee = {
    authorized: true,
    audienceRef,
    ownerSubjectRef: subjectRef,
    deviceFingerprint: granteeDevice.fingerprint,
    ...overrides.grantee,
  };
  return {
    identity,
    tenantId,
    subjectRef,
    actorDevice,
    granteeDevice,
    audienceRef,
    program,
    membership,
    grantee,
  };
}

function requestFor(fixture, overrides = {}) {
  return {
    grantVersion: 1,
    kind: "publisher",
    roomId: ROOM_ID,
    programId: PROGRAM_ID,
    programRevision: fixture.program.revision,
    programEpoch: fixture.program.programEpoch,
    audienceRef: fixture.audienceRef,
    actions: ["whip:create"],
    resourceRef: RESOURCE_REF,
    pathPrefix: `/broadcast/ingest/${RESOURCE_REF}`,
    ...overrides,
  };
}

let proofCounter = 0;
function attachProof(fixture, input, at = NOW) {
  proofCounter += 1;
  const nonce = Buffer.from(`grant-proof-${proofCounter}`.padEnd(24, "x")).toString("base64url");
  const pathHash = broadcastGrantPathHash(input.pathPrefix);
  const context = {
    tenantId: fixture.tenantId,
    subjectRef: fixture.subjectRef,
    roomId: input.roomId,
    programId: input.programId,
    programRevision: input.programRevision,
    programEpoch: input.programEpoch,
    grantKind: input.kind,
    tokenAudience: `broadcast-${input.kind}`,
    audienceRef: input.audienceRef,
    resourceRef: input.resourceRef,
    pathHash,
    actions: [...input.actions].sort(),
  };
  const signature = crypto.sign(
    "sha256",
    Buffer.from(broadcastGrantDeviceProofMessage(context, at, nonce)),
    { key: fixture.granteeDevice.privateKey, dsaEncoding: "ieee-p1363" },
  );
  return {
    ...input,
    deviceProof: {
      publicKey: fixture.granteeDevice.publicKey,
      timestamp: at,
      nonce,
      signature: signature.toString("base64url"),
    },
  };
}

function authorizationFor(fixture, overrides = {}) {
  return {
    identity: fixture.identity,
    membership: fixture.membership,
    grantee: fixture.grantee,
    program: fixture.program,
    ...overrides,
  };
}

function authority(overrides = {}) {
  let nextId = 0;
  return new BroadcastGrantAuthority({
    issuer: "https://webrtc.test",
    oidcIssuer: ISSUER,
    oidcAudience: OIDC_AUDIENCE,
    oidcAlgorithms: ["RS256"],
    signingKeys: [signingKey("grant-key-1")],
    activeKid: "grant-key-1",
    deviceProofVerifier: new BroadcastDeviceProofVerifier({ maxAgeMs: 60_000 }),
    idFactory: () => `grt_${String(++nextId).padStart(16, "a")}`,
    ...overrides,
  });
}

function expectation(issued, fixture, overrides = {}) {
  return {
    audience: issued.grant.tokenAudience,
    action: issued.grant.actions[0],
    tenantId: fixture.tenantId,
    subjectRef: fixture.subjectRef,
    audienceRef: fixture.audienceRef,
    deviceRef: issued.grant.deviceRef,
    roomId: ROOM_ID,
    programId: PROGRAM_ID,
    programRevision: fixture.program.revision,
    programEpoch: fixture.program.programEpoch,
    resourceRef: RESOURCE_REF,
    path: `/broadcast/ingest/${RESOURCE_REF}`,
    ...overrides,
  };
}

test("publisher grant is OIDC-, membership-, device-, path-, action- and epoch-bound", async () => {
  const fixture = baseFixture();
  const grants = authority();
  const request = attachProof(fixture, requestFor(fixture));
  const tampered = {
    ...attachProof(fixture, requestFor(fixture)),
    pathPrefix: `/broadcast/ingest/res_bbbbbbbbbbbbbbbb`,
  };
  await assert.rejects(
    grants.issue(tampered, authorizationFor(fixture), NOW),
    (error) => error.code === "invalid_broadcast_device_signature",
  );
  const issued = await grants.issue(request, authorizationFor(fixture), NOW);

  assert.equal(issued.grant.grantKind, "publisher");
  assert.equal(issued.grant.tokenAudience, "broadcast-publisher");
  assert.equal(issued.grant.tenantId, fixture.tenantId);
  assert.equal(issued.grant.issuerSubjectRef, fixture.subjectRef);
  assert.equal(issued.grant.singleUse, true);
  assert.equal(Object.hasOwn(issued.grant, "token"), false);
  assert.equal(JSON.stringify(issued.grant).includes(issued.token), false);
  assert.match(issued.token, /^[^.]+\.[^.]+\.[^.]+$/);
  await assert.rejects(
    grants.issue(request, authorizationFor(fixture), NOW + 1),
    (error) => error.code === "broadcast_device_proof_replayed",
  );

  const authorized = await grants.authorizeBearer(
    `Bearer ${issued.token}`,
    expectation(issued, fixture),
    NOW + 1_000,
  );
  assert.equal(authorized.status, "consumed");
  assert.equal(authorized.revision, 2);
  await assert.rejects(
    grants.authorizeBearer(`Bearer ${issued.token}`, expectation(issued, fixture), NOW + 2_000),
    errorCode("inactive_broadcast_grant"),
  );
  await assert.rejects(
    grants.authorizeBearer(undefined, expectation(issued, fixture)),
    errorCode("broadcast_grant_required"),
  );
});

test("playback grant binds policy and authorizes only its path prefix without consumption", async () => {
  const fixture = baseFixture({ program: { state: "live" } });
  const policy = {
    contractVersion: 1,
    type: "viewer-policy",
    tenantId: fixture.tenantId,
    ownerSubjectRef: fixture.subjectRef,
    roomId: ROOM_ID,
    programId: PROGRAM_ID,
    policyId: POLICY_ID,
    revision: 3,
    programEpoch: fixture.program.programEpoch,
    visibility: "private",
    authentication: "required",
    directoryListed: false,
    anonymousAllowed: false,
    allowedOriginHashes: [],
    updatedAt: NOW,
  };
  const request = attachProof(fixture, requestFor(fixture, {
    kind: "playback",
    actions: ["playback:manifest", "playback:segment"],
    pathPrefix: `/broadcast/play/${RESOURCE_REF}`,
    policyId: POLICY_ID,
    policyRevision: policy.revision,
  }));
  const grants = authority();
  const issued = await grants.issue(request, authorizationFor(fixture, { viewerPolicy: policy }), NOW);
  const expected = expectation(issued, fixture, {
    audience: "broadcast-playback",
    action: "playback:manifest",
    path: `/broadcast/play/${RESOURCE_REF}/index.m3u8`,
    policyId: POLICY_ID,
    policyRevision: policy.revision,
  });
  assert.equal((await grants.authorizeBearer(`Bearer ${issued.token}`, expected, NOW + 1_000)).status, "issued");
  assert.equal((await grants.authorizeBearer(`Bearer ${issued.token}`, {
    ...expected,
    action: "playback:segment",
    path: `/broadcast/play/${RESOURCE_REF}/part-001.m4s`,
  }, NOW + 2_000)).status, "issued");

  for (const [patch, code] of [
    [{ audience: "broadcast-packager" }, "invalid_broadcast_grant"],
    [{ tenantId: broadcastTenantRef("https://other.test") }, "broadcast_grant_scope_mismatch"],
    [{ subjectRef: "sub_zzzzzzzzzzzzzzzz" }, "broadcast_grant_scope_mismatch"],
    [{ roomId: "room-other" }, "broadcast_grant_scope_mismatch"],
    [{ programId: "prg_zzzzzzzzzzzzzzzz" }, "broadcast_grant_scope_mismatch"],
    [{ programEpoch: fixture.program.programEpoch + 1 }, "broadcast_grant_scope_mismatch"],
    [{ deviceRef: "dev_zzzzzzzzzzzzzzzz" }, "broadcast_grant_scope_mismatch"],
    [{ action: "whep:read" }, "broadcast_grant_action_denied"],
    [{ path: "/broadcast/play/res_zzzzzzzzzzzzzzzz/index.m3u8" }, "broadcast_grant_path_mismatch"],
  ]) {
    await assert.rejects(
      grants.authorizeBearer(`Bearer ${issued.token}`, { ...expected, ...patch }, NOW + 3_000),
      errorCode(code),
    );
  }
  await assert.rejects(
    grants.authorizeBearer(`Bearer ${issued.token}`, expected, issued.grant.expiresAt),
    (error) => error instanceof BroadcastGrantError
      && new Set(["invalid_broadcast_grant", "inactive_broadcast_grant"]).has(error.code),
  );
});

test("trusted packager grant requires complete fresh source consent and its registered device", async () => {
  const packagerDevice = device();
  const fixture = baseFixture({
    granteeDevice: packagerDevice,
    audienceRef: "pkr_dddddddddddddddd",
    program: {
      sourceIds: ["src_aaaaaaaaaaaaaaaa", "src_bbbbbbbbbbbbbbbb"],
    },
    membership: { role: "packager" },
  });
  const consent = {
    contractVersion: 1,
    type: "consent",
    tenantId: fixture.tenantId,
    grantorSubjectRef: fixture.subjectRef,
    roomId: ROOM_ID,
    programId: PROGRAM_ID,
    consentId: "cns_aaaaaaaaaaaaaaaa",
    granteeRef: fixture.audienceRef,
    revision: 1,
    programEpoch: fixture.program.programEpoch,
    sourceIds: [...fixture.program.sourceIds],
    actions: ["decrypt-source", "compose-program", "publish-program"],
    status: "active",
    grantedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
  };
  const request = attachProof(fixture, requestFor(fixture, { kind: "packager" }));
  const grants = authority();
  const issued = await grants.issue(request, authorizationFor(fixture, { consents: [consent] }), NOW);
  assert.equal(issued.grant.audienceRef, fixture.audienceRef);
  assert.notEqual(issued.grant.deviceRef, `dev_${fixture.actorDevice.fingerprint}`);

  const noConsentFixture = baseFixture({
    granteeDevice: packagerDevice,
    audienceRef: fixture.audienceRef,
    program: { sourceIds: [...fixture.program.sourceIds] },
    membership: { role: "packager" },
  });
  await assert.rejects(
    grants.issue(
      attachProof(noConsentFixture, requestFor(noConsentFixture, { kind: "packager" })),
      authorizationFor(noConsentFixture, { consents: [] }),
      NOW,
    ),
    errorCode("broadcast_packager_consent_required"),
  );

  const wrongDevice = baseFixture();
  const mismatched = attachProof(wrongDevice, requestFor(wrongDevice));
  wrongDevice.grantee.deviceFingerprint = device().fingerprint;
  await assert.rejects(
    grants.issue(mismatched, authorizationFor(wrongDevice), NOW),
    errorCode("broadcast_grant_device_mismatch"),
  );
});

test("OIDC attestation, current room role and exact program revision fail closed", async () => {
  for (const [fixtureOverrides, requestOverrides, code] of [
    [{ identity: { issuer: "https://other.test" } }, {}, "invalid_broadcast_oidc_identity"],
    [{ identity: { audience: "other-audience" } }, {}, "invalid_broadcast_oidc_identity"],
    [{ identity: { algorithm: "none" } }, {}, "invalid_broadcast_oidc_identity"],
    [{ identity: { expiresAt: NOW } }, {}, "invalid_broadcast_oidc_identity"],
    [{ membership: { active: false } }, {}, "invalid_broadcast_membership"],
    [{ membership: { role: "viewer" } }, {}, "invalid_broadcast_membership"],
    [{}, { programRevision: 3 }, "broadcast_grant_program_mismatch"],
  ]) {
    const fixture = baseFixture(fixtureOverrides);
    const grants = authority();
    const request = attachProof(fixture, requestFor(fixture, requestOverrides));
    await assert.rejects(
      grants.issue(request, authorizationFor(fixture), NOW),
      errorCode(code),
    );
  }
  const missingSubject = baseFixture();
  missingSubject.identity.subject = "";
  await assert.rejects(
    authority().issue(
      attachProof(missingSubject, requestFor(missingSubject)),
      authorizationFor(missingSubject),
      NOW,
    ),
    errorCode("invalid_broadcast_oidc_identity"),
  );
});

test("quota, explicit revoke, epoch revoke and signing-key rotation invalidate grants immediately", async () => {
  const fixture = baseFixture({ program: { state: "live" } });
  const policy = {
    contractVersion: 1,
    type: "viewer-policy",
    tenantId: fixture.tenantId,
    ownerSubjectRef: fixture.subjectRef,
    roomId: ROOM_ID,
    programId: PROGRAM_ID,
    policyId: POLICY_ID,
    revision: 1,
    programEpoch: fixture.program.programEpoch,
    visibility: "private",
    authentication: "required",
    directoryListed: false,
    anonymousAllowed: false,
    allowedOriginHashes: [],
    updatedAt: NOW,
  };
  const grants = authority({ maxActiveGrantsPerSubject: 1 });
  const makeRequest = () => attachProof(fixture, requestFor(fixture, {
    kind: "playback",
    actions: ["playback:manifest"],
    pathPrefix: `/broadcast/play/${RESOURCE_REF}`,
    policyId: POLICY_ID,
    policyRevision: policy.revision,
  }));
  const issued = await grants.issue(makeRequest(), authorizationFor(fixture, { viewerPolicy: policy }), NOW);
  await assert.rejects(
    grants.issue(makeRequest(), authorizationFor(fixture, { viewerPolicy: policy }), NOW + 1),
    errorCode("broadcast_grant_quota_reached"),
  );
  assert.equal(grants.revokeGrant(issued.grant.grantId, NOW + 2), true);
  await assert.rejects(
    grants.authorizeBearer(`Bearer ${issued.token}`, expectation(issued, fixture, {
      audience: "broadcast-playback",
      action: "playback:manifest",
      path: `/broadcast/play/${RESOURCE_REF}/index.m3u8`,
      policyId: POLICY_ID,
      policyRevision: policy.revision,
    }), NOW + 3),
    errorCode("inactive_broadcast_grant"),
  );

  const beforeRotation = await grants.issue(
    makeRequest(),
    authorizationFor(fixture, { viewerPolicy: policy }),
    NOW + 4,
  );
  const inventory = grants.rotateSigningKey(signingKey("grant-key-2"), NOW + 5);
  assert.deepEqual(inventory.map(({ kid, active }) => [kid, active]), [
    ["grant-key-1", false],
    ["grant-key-2", true],
  ]);
  assert.equal(JSON.stringify(inventory).includes("privateKey"), false);
  await assert.rejects(
    grants.authorizeBearer(`Bearer ${beforeRotation.token}`, expectation(beforeRotation, fixture, {
      audience: "broadcast-playback",
      action: "playback:manifest",
      path: `/broadcast/play/${RESOURCE_REF}/index.m3u8`,
      policyId: POLICY_ID,
      policyRevision: policy.revision,
    }), NOW + 6),
    errorCode("inactive_broadcast_grant"),
  );
  grants.disableSigningKey("grant-key-1", NOW + 6);
  assert.equal(grants.keyInventory().find(({ kid }) => kid === "grant-key-1").enabled, false);
  await assert.rejects(
    grants.authorizeBearer(`Bearer ${beforeRotation.token}`, expectation(beforeRotation, fixture, {
      audience: "broadcast-playback",
      action: "playback:manifest",
      path: `/broadcast/play/${RESOURCE_REF}/index.m3u8`,
      policyId: POLICY_ID,
      policyRevision: policy.revision,
    }), NOW + 6),
    errorCode("invalid_broadcast_grant"),
  );

  const afterRotation = await grants.issue(
    makeRequest(),
    authorizationFor(fixture, { viewerPolicy: policy }),
    NOW + 7,
  );
  assert.equal(grants.revokeProgramEpoch(
    fixture.tenantId,
    PROGRAM_ID,
    fixture.program.programEpoch,
    NOW + 8,
  ), 1);
  await assert.rejects(
    grants.authorizeBearer(`Bearer ${afterRotation.token}`, expectation(afterRotation, fixture, {
      audience: "broadcast-playback",
      action: "playback:manifest",
      path: `/broadcast/play/${RESOURCE_REF}/index.m3u8`,
      policyId: POLICY_ID,
      policyRevision: policy.revision,
    }), NOW + 9),
    errorCode("revoked_broadcast_program_epoch"),
  );
  await assert.rejects(
    grants.issue(makeRequest(), authorizationFor(fixture, { viewerPolicy: policy }), NOW + 10),
    errorCode("revoked_broadcast_program_epoch"),
  );
});
