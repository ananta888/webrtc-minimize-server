import assert from "node:assert/strict";
import test from "node:test";

import {
  TrustedDecryptConsentAuthority,
  TrustedDecryptConsentError,
} from "../src/trusted-decrypt-consent-authority.js";

const NOW = 1_800_000_000_000;
const request = (patch = {}) => ({
  requestVersion: 1,
  requestId: "request-aaaaaaaaaaaaaaaa",
  trigger: "user-action",
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  roomEpoch: 11,
  programId: "prg_aaaaaaaaaaaaaaaa",
  programEpoch: 7,
  sourceId: "src_aaaaaaaaaaaaaaaa",
  sourceKind: "camera",
  purpose: "broadcast-program",
  granteePackagerRef: "pkr_dddddddddddddddd",
  granteeDeviceRef: "dev_eeeeeeeeeeeeeeee",
  ttlMs: 60_000,
  ...patch,
});
const context = (patch = {}) => ({
  identity: { authenticated: true, tenantId: "tn_aaaaaaaaaaaaaaaa", subjectRef: "sub_cccccccccccccccc" },
  membership: {
    active: true,
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    roomEpoch: 11,
    subjectRef: "sub_cccccccccccccccc",
    deviceRef: "dev_aaaaaaaaaaaaaaaa",
    sources: [{ sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "camera", active: true }],
  },
  packager: {
    registered: true,
    authorized: true,
    packagerRef: "pkr_dddddddddddddddd",
    deviceRef: "dev_eeeeeeeeeeeeeeee",
  },
  lease: {
    active: true,
    roomId: "room-alpha",
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    holderRef: "pkr_dddddddddddddddd",
    deviceRef: "dev_eeeeeeeeeeeeeeee",
    expiresAt: NOW + 120_000,
  },
  program: {
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    state: "awaiting_consent",
    sourceIds: ["src_aaaaaaaaaaaaaaaa"],
  },
  ...patch,
});
const error = (code) => (value) => value instanceof TrustedDecryptConsentError && value.code === code;

test("issues one source- and device-bound consent only after all current authorities agree", () => {
  const authority = new TrustedDecryptConsentAuthority({ idFactory: () => "cns_aaaaaaaaaaaaaaaa" });
  const consent = authority.issue(request(), context(), NOW);
  assert.deepEqual(consent, {
    version: 1,
    type: "trusted-decrypt-consent",
    trigger: "user-action",
    consentId: "cns_aaaaaaaaaaaaaaaa",
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    roomEpoch: 11,
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    grantorSubjectRef: "sub_cccccccccccccccc",
    granteePackagerRef: "pkr_dddddddddddddddd",
    granteeDeviceRef: "dev_eeeeeeeeeeeeeeee",
    sourceId: "src_aaaaaaaaaaaaaaaa",
    sourceKind: "camera",
    purpose: "broadcast-program",
    status: "active",
    grantedAt: NOW,
    expiresAt: NOW + 60_000,
  });
  assert.strictEqual(authority.issue(request(), context(), NOW + 1), consent);
  assert.equal(Object.isFrozen(consent), true);
});

test("fails closed for remote trigger, stale scope, wrong source, target, registration and lease", () => {
  const cases = [
    [request({ trigger: "remote-signal" }), context(), "invalid_trusted_decrypt_request"],
    [request(), context({ membership: { ...context().membership, roomEpoch: 12 } }), "invalid_trusted_decrypt_membership"],
    [request({ sourceKind: "screen" }), context(), "trusted_decrypt_source_unauthorized"],
    [request(), context({ packager: { ...context().packager, deviceRef: "dev_ffffffffffffffff" } }), "invalid_trusted_decrypt_packager"],
    [request(), context({ packager: { ...context().packager, registered: false } }), "invalid_trusted_decrypt_packager"],
    [request(), context({ lease: { ...context().lease, active: false } }), "invalid_trusted_decrypt_lease"],
    [request(), context({ lease: { ...context().lease, expiresAt: NOW } }), "invalid_trusted_decrypt_lease"],
    [request(), context({ program: { ...context().program, programEpoch: 8 } }), "invalid_trusted_decrypt_program"],
  ];
  for (const [input, authorization, code] of cases) {
    assert.throws(() => new TrustedDecryptConsentAuthority().issue(input, authorization, NOW), error(code));
  }
});

test("prevents replay mutation, silent source extension and concurrent source consent", () => {
  let sequence = 0;
  const authority = new TrustedDecryptConsentAuthority({
    idFactory: () => `cns_${String(++sequence).padStart(16, "a")}`,
  });
  authority.issue(request(), context(), NOW);
  assert.throws(() => authority.issue(request({ ttlMs: 90_000 }), context(), NOW),
    error("trusted_decrypt_request_replay"));
  assert.throws(() => authority.issue({ ...request({ requestId: "request-bbbbbbbbbbbbbbbb" }), sourceIds: [
    "src_aaaaaaaaaaaaaaaa", "src_bbbbbbbbbbbbbbbb",
  ] }, context(), NOW), error("invalid_trusted_decrypt_request"));
  assert.throws(() => authority.issue(request({ requestId: "request-cccccccccccccccc" }), context(), NOW),
    error("trusted_decrypt_source_already_consented"));
});

test("revocation, expiry, handoff and epoch drift produce bounded content-free audit", () => {
  let sequence = 0;
  const authority = new TrustedDecryptConsentAuthority({
    idFactory: () => `cns_${String(++sequence).padStart(16, "a")}`,
  });
  const first = authority.issue(request(), context(), NOW);
  assert.throws(() => authority.revoke(first.consentId, "sub_ffffffffffffffff", "user-revoked", NOW + 1),
    error("trusted_decrypt_revoke_forbidden"));
  assert.equal(authority.revoke(first.consentId, first.grantorSubjectRef, "user-revoked", NOW + 1).status, "revoked");

  const second = authority.issue(request({ requestId: "request-bbbbbbbbbbbbbbbb", programEpoch: 8 }), context({
    program: { ...context().program, programEpoch: 8 },
    lease: { ...context().lease, programEpoch: 8 },
  }), NOW + 2);
  authority.revokeScope({
    roomId: second.roomId,
    roomEpoch: second.roomEpoch,
    programId: second.programId,
    programEpoch: 9,
    granteeDeviceRef: second.granteeDeviceRef,
    reasonCode: "program-epoch-changed",
  }, NOW + 3);
  assert.equal(authority.list(second.grantorSubjectRef, NOW + 3).at(-1).status, "revoked");

  const third = authority.issue(request({
    requestId: "request-cccccccccccccccc", programEpoch: 9, ttlMs: 5_000,
  }), context({
    program: { ...context().program, programEpoch: 9 },
    lease: { ...context().lease, programEpoch: 9 },
  }), NOW + 4);
  assert.throws(() => authority.revoke(third.consentId, third.grantorSubjectRef, "free-form secret", NOW + 5),
    error("invalid_trusted_decrypt_reason"));
  authority.revokeExpired(third.expiresAt);
  assert.equal(authority.list(third.grantorSubjectRef, third.expiresAt).at(-1).status, "revoked");

  const events = authority.auditEvents();
  assert.deepEqual(events.map(({ eventType, reasonCode }) => ({ eventType, reasonCode })), [
    { eventType: "consent-granted", reasonCode: "user-action" },
    { eventType: "consent-revoked", reasonCode: "user-revoked" },
    { eventType: "consent-granted", reasonCode: "user-action" },
    { eventType: "consent-revoked", reasonCode: "program-epoch-changed" },
    { eventType: "consent-granted", reasonCode: "user-action" },
    { eventType: "consent-revoked", reasonCode: "expired" },
  ]);
  for (const event of events) {
    for (const forbidden of ["key", "keyId", "publicKey", "ciphertext", "token", "name", "sdp", "ice"] ) {
      assert.equal(Object.hasOwn(event, forbidden), false);
    }
  }
});
