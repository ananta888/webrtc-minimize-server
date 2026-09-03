import crypto from "node:crypto";

import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";

import {
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";
import { BroadcastDeviceProofVerifier } from "./broadcast-device-proof.js";
import {
  BROADCAST_GRANT_AUDIENCE,
  BroadcastGrantError,
  authorizeBroadcastGrantRequest,
  broadcastGrantFail,
  broadcastGrantPathHash,
  broadcastGrantPathMatches,
  normalizeBroadcastGrantExpectation,
  normalizeBroadcastGrantRequest,
} from "./broadcast-grant-policy.js";
import { assertBroadcastTransition } from "./broadcast-transitions.js";
import { bearerToken } from "./oidc-verifier.js";

export { BroadcastGrantError, broadcastGrantPathHash } from "./broadcast-grant-policy.js";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const GRANT_ID_PATTERN = /^grt_[A-Za-z0-9_-]{16,64}$/;

const fail = broadcastGrantFail;

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, 400);
  return value;
}

function validHttpsIssuer(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizeKey(value, generation) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !new Set(["kid", "privateKey", "publicKey"]).has(field))
    || !KEY_ID_PATTERN.test(value.kid || "")
    || value.privateKey?.type !== "private" || value.publicKey?.type !== "public"
    || value.privateKey.asymmetricKeyType !== "ec" || value.publicKey.asymmetricKeyType !== "ec"
    || value.privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    || value.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    fail("invalid_broadcast_signing_key", 500);
  }
  return Object.freeze({
    kid: value.kid,
    privateKey: value.privateKey,
    publicKey: value.publicKey,
    generation,
    enabled: true,
  });
}

function checkedContract(value, context, now) {
  try {
    return validateBroadcastContract(value, context, now);
  } catch (error) {
    if (error instanceof BroadcastContractError) fail(error.code);
    throw error;
  }
}

export class BroadcastGrantAuthority {
  #issuer;
  #oidcIssuer;
  #oidcAudience;
  #oidcAlgorithms;
  #ttlMs;
  #retentionMs;
  #limits;
  #keys = new Map();
  #activeKid;
  #keyGeneration = 1;
  #records = new Map();
  #revokedEpochs = new Set();
  #deviceProofVerifier;
  #idFactory;

  constructor(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)
      || !validHttpsIssuer(options.issuer) || !validHttpsIssuer(options.oidcIssuer)
      || typeof options.oidcAudience !== "string" || options.oidcAudience.length < 1
      || !Array.isArray(options.oidcAlgorithms) || options.oidcAlgorithms.length < 1
      || options.oidcAlgorithms.some((algorithm) => typeof algorithm !== "string")
      || !Array.isArray(options.signingKeys) || options.signingKeys.length < 1) {
      fail("invalid_broadcast_grant_configuration", 500);
    }
    this.#issuer = options.issuer;
    this.#oidcIssuer = options.oidcIssuer;
    this.#oidcAudience = options.oidcAudience;
    this.#oidcAlgorithms = new Set(options.oidcAlgorithms);
    this.#ttlMs = Object.freeze({
      publisher: options.ttlMs?.publisher ?? 60_000,
      packager: options.ttlMs?.packager ?? 60_000,
      playback: options.ttlMs?.playback ?? 120_000,
    });
    for (const ttl of Object.values(this.#ttlMs)) {
      if (!Number.isSafeInteger(ttl) || ttl < 5_000 || ttl > 5 * 60_000) {
        fail("invalid_broadcast_grant_configuration", 500);
      }
    }
    this.#retentionMs = options.retentionMs ?? 5 * 60_000;
    this.#limits = Object.freeze({
      subject: options.maxActiveGrantsPerSubject ?? 16,
      tenant: options.maxActiveGrantsPerTenant ?? 256,
      program: options.maxActiveGrantsPerProgram ?? 64,
    });
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 0
      || Object.values(this.#limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
      fail("invalid_broadcast_grant_configuration", 500);
    }
    for (const value of options.signingKeys) {
      const key = normalizeKey(value, this.#keyGeneration);
      if (this.#keys.has(key.kid)) fail("duplicate_broadcast_signing_key", 500);
      this.#keys.set(key.kid, key);
    }
    this.#activeKid = options.activeKid || options.signingKeys[0].kid;
    if (!this.#keys.has(this.#activeKid)) fail("invalid_broadcast_active_signing_key", 500);
    this.#deviceProofVerifier = options.deviceProofVerifier || new BroadcastDeviceProofVerifier();
    this.#idFactory = options.idFactory || (() => `grt_${crypto.randomBytes(18).toString("base64url")}`);
  }

  #identityConfig() {
    return Object.freeze({
      oidcIssuer: this.#oidcIssuer,
      oidcAudience: this.#oidcAudience,
      oidcAlgorithms: this.#oidcAlgorithms,
    });
  }

  #epochKey(tenantId, programId, programEpoch) {
    return `${tenantId}\0${programId}\0${programEpoch}`;
  }

  #activeRecords(now) {
    return [...this.#records.values()].filter(({ grant }) => (
      grant.status === "issued" && grant.expiresAt > now
    ));
  }

  #assertQuota(tenantId, subjectRef, programId, now) {
    const active = this.#activeRecords(now);
    if (active.filter(({ grant }) => grant.issuerSubjectRef === subjectRef).length >= this.#limits.subject
      || active.filter(({ grant }) => grant.tenantId === tenantId).length >= this.#limits.tenant
      || active.filter(({ grant }) => grant.programId === programId).length >= this.#limits.program) {
      fail("broadcast_grant_quota_reached", 429);
    }
  }

  #transition(record, status, now) {
    if (record.grant.status !== "issued") return record.grant;
    const next = {
      ...record.grant,
      revision: record.grant.revision + 1,
      status,
      ...(status === "consumed" ? { consumedAt: now } : {}),
      ...(status === "revoked" ? { revokedAt: now } : {}),
    };
    try {
      record.grant = assertBroadcastTransition(record.grant, next, { requireFresh: false }, now);
    } catch (error) {
      if (error instanceof BroadcastContractError) fail(error.code);
      throw error;
    }
    return record.grant;
  }

  async issue(input, authorization, now = Date.now()) {
    const request = normalizeBroadcastGrantRequest(input);
    const authorized = authorizeBroadcastGrantRequest(
      request,
      authorization,
      this.#identityConfig(),
      now,
    );
    const {
      identity,
      refs,
      membership,
      grantee,
      program,
      viewerPolicy,
    } = authorized;
    const epochKey = this.#epochKey(refs.tenantId, request.programId, request.programEpoch);
    if (this.#revokedEpochs.has(epochKey)) fail("revoked_broadcast_program_epoch");
    this.prune(now);
    this.#assertQuota(refs.tenantId, refs.subjectRef, request.programId, now);

    const pathHash = broadcastGrantPathHash(request.pathPrefix);
    const proof = this.#deviceProofVerifier.verify(request.deviceProof, {
      tenantId: refs.tenantId,
      subjectRef: refs.subjectRef,
      roomId: request.roomId,
      programId: request.programId,
      programRevision: request.programRevision,
      programEpoch: request.programEpoch,
      grantKind: request.kind,
      tokenAudience: BROADCAST_GRANT_AUDIENCE[request.kind],
      audienceRef: request.audienceRef,
      resourceRef: request.resourceRef,
      pathHash,
      actions: request.actions,
    }, now);
    if (proof.fingerprint !== grantee.deviceFingerprint) fail("broadcast_grant_device_mismatch");
    if (request.kind !== "packager" && membership.deviceFingerprint !== grantee.deviceFingerprint) {
      fail("broadcast_grant_device_mismatch");
    }

    const grantId = this.#idFactory();
    if (!GRANT_ID_PATTERN.test(grantId) || this.#records.has(grantId)) {
      fail("invalid_broadcast_grant_id", 500);
    }
    const expiresAt = Math.min(now + this.#ttlMs[request.kind], identity.expiresAt);
    if (expiresAt <= now) fail("invalid_broadcast_oidc_identity");
    const grant = checkedContract({
      contractVersion: 1,
      type: "grant",
      tenantId: refs.tenantId,
      issuerSubjectRef: refs.subjectRef,
      roomId: request.roomId,
      programId: request.programId,
      grantId,
      grantKind: request.kind,
      tokenAudience: BROADCAST_GRANT_AUDIENCE[request.kind],
      audienceRef: request.audienceRef,
      deviceRef: proof.deviceRef,
      revision: 1,
      programEpoch: request.programEpoch,
      actions: request.actions,
      resourceRef: request.resourceRef,
      pathHash,
      ...(viewerPolicy ? {
        policyId: viewerPolicy.policyId,
        policyRevision: viewerPolicy.revision,
      } : {}),
      status: "issued",
      singleUse: request.kind !== "playback",
      issuedAt: now,
      notBefore: now,
      expiresAt,
    }, {
      tenantId: refs.tenantId,
      roomId: request.roomId,
      programId: request.programId,
      programEpoch: request.programEpoch,
      allowedSubjectRefs: [refs.subjectRef],
      allowedPrincipalRefs: [request.audienceRef],
      requireFresh: true,
    }, now);

    const key = this.#keys.get(this.#activeKid);
    const issuedAtSeconds = Math.floor(now / 1_000);
    const token = await new SignJWT({
      tenant_ref: grant.tenantId,
      actor_ref: grant.issuerSubjectRef,
      audience_ref: grant.audienceRef,
      device_ref: grant.deviceRef,
      room_id: grant.roomId,
      program_id: grant.programId,
      program_revision: request.programRevision,
      program_epoch: grant.programEpoch,
      grant_kind: grant.grantKind,
      actions: grant.actions,
      resource_ref: grant.resourceRef,
      path_hash: grant.pathHash,
      policy_id: grant.policyId,
      policy_revision: grant.policyRevision,
      key_generation: key.generation,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: key.kid })
      .setIssuer(this.#issuer)
      .setAudience(grant.tokenAudience)
      .setSubject(grant.audienceRef)
      .setJti(grant.grantId)
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds)
      .setExpirationTime(Math.ceil(expiresAt / 1_000))
      .sign(key.privateKey);

    this.#records.set(grant.grantId, {
      grant,
      programRevision: request.programRevision,
      pathPrefix: request.pathPrefix,
      kid: key.kid,
      keyGeneration: key.generation,
    });
    return Object.freeze({ grant, token });
  }

  async authorizeBearer(authorizationHeader, expectation, now = Date.now()) {
    let token;
    try {
      token = bearerToken(authorizationHeader);
    } catch {
      fail("invalid_broadcast_authorization_header", 401);
    }
    if (!token) fail("broadcast_grant_required", 401);
    if (token.length > 8 * 1024) fail("invalid_broadcast_grant", 401);
    const expected = normalizeBroadcastGrantExpectation(expectation);
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      fail("invalid_broadcast_grant", 401);
    }
    const key = this.#keys.get(header.kid);
    if (!key || !key.enabled || header.alg !== "ES256" || header.typ !== "JWT") {
      fail("invalid_broadcast_grant", 401);
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, key.publicKey, {
        issuer: this.#issuer,
        audience: expected.audience,
        algorithms: ["ES256"],
        requiredClaims: ["iss", "aud", "sub", "jti", "iat", "nbf", "exp"],
        currentDate: new Date(now),
      }));
    } catch {
      fail("invalid_broadcast_grant", 401);
    }
    const record = this.#records.get(payload.jti);
    if (!record) fail("inactive_broadcast_grant", 401);
    if (this.#revokedEpochs.has(this.#epochKey(
      record.grant.tenantId,
      record.grant.programId,
      record.grant.programEpoch,
    ))) fail("revoked_broadcast_program_epoch");
    if (record.grant.status !== "issued" || record.grant.expiresAt <= now
      || record.kid !== key.kid || record.keyGeneration !== payload.key_generation) {
      fail("inactive_broadcast_grant", 401);
    }
    const grant = record.grant;
    const comparisons = [
      [payload.tenant_ref, grant.tenantId],
      [payload.actor_ref, grant.issuerSubjectRef],
      [payload.audience_ref, grant.audienceRef],
      [payload.device_ref, grant.deviceRef],
      [payload.room_id, grant.roomId],
      [payload.program_id, grant.programId],
      [payload.program_revision, record.programRevision],
      [payload.program_epoch, grant.programEpoch],
      [payload.grant_kind, grant.grantKind],
      [payload.resource_ref, grant.resourceRef],
      [payload.path_hash, grant.pathHash],
      [payload.policy_id, grant.policyId],
      [payload.policy_revision, grant.policyRevision],
      [payload.sub, grant.audienceRef],
    ];
    if (comparisons.some(([actual, wanted]) => actual !== wanted)
      || JSON.stringify(payload.actions) !== JSON.stringify(grant.actions)) {
      fail("invalid_broadcast_grant", 401);
    }
    for (const [actual, wanted] of [
      [grant.tokenAudience, expected.audience],
      [grant.tenantId, expected.tenantId],
      [grant.issuerSubjectRef, expected.subjectRef],
      [grant.audienceRef, expected.audienceRef],
      [grant.deviceRef, expected.deviceRef],
      [grant.roomId, expected.roomId],
      [grant.programId, expected.programId],
      [record.programRevision, expected.programRevision],
      [grant.programEpoch, expected.programEpoch],
      [grant.resourceRef, expected.resourceRef],
      [grant.policyId, expected.policyId],
      [grant.policyRevision, expected.policyRevision],
    ]) {
      if (actual !== wanted) fail("broadcast_grant_scope_mismatch");
    }
    if (!grant.actions.includes(expected.action)) fail("broadcast_grant_action_denied");
    if (!broadcastGrantPathMatches(expected.path, record.pathPrefix)
      || grant.pathHash !== broadcastGrantPathHash(record.pathPrefix)) {
      fail("broadcast_grant_path_mismatch");
    }
    if (grant.singleUse) return this.#transition(record, "consumed", now);
    return grant;
  }

  revokeGrant(grantId, now = Date.now()) {
    const record = this.#records.get(grantId);
    if (!record) return false;
    this.#transition(record, "revoked", now);
    return true;
  }

  revokeProgramEpoch(tenantId, programId, programEpoch, now = Date.now()) {
    const epoch = positiveInteger(programEpoch, "invalid_broadcast_program_epoch");
    const key = this.#epochKey(tenantId, programId, epoch);
    this.#revokedEpochs.add(key);
    let revoked = 0;
    for (const record of this.#records.values()) {
      if (record.grant.tenantId === tenantId && record.grant.programId === programId
        && record.grant.programEpoch === epoch && record.grant.status === "issued") {
        this.#transition(record, "revoked", now);
        revoked += 1;
      }
    }
    return revoked;
  }

  rotateSigningKey(value, now = Date.now()) {
    this.#keyGeneration += 1;
    const key = normalizeKey(value, this.#keyGeneration);
    if (this.#keys.has(key.kid)) fail("duplicate_broadcast_signing_key", 500);
    for (const record of this.#records.values()) this.#transition(record, "revoked", now);
    this.#keys.set(key.kid, key);
    this.#activeKid = key.kid;
    return this.keyInventory();
  }

  disableSigningKey(kid, now = Date.now()) {
    const current = this.#keys.get(kid);
    if (!current || kid === this.#activeKid) fail("invalid_broadcast_signing_key_state", 409);
    this.#keys.set(kid, Object.freeze({ ...current, privateKey: null, enabled: false }));
    for (const record of this.#records.values()) {
      if (record.kid === kid) this.#transition(record, "revoked", now);
    }
  }

  keyInventory() {
    return Object.freeze([...this.#keys.values()].map((key) => Object.freeze({
      kid: key.kid,
      generation: key.generation,
      active: key.kid === this.#activeKid,
      enabled: key.enabled,
    })));
  }

  grant(grantId) {
    return this.#records.get(grantId)?.grant || null;
  }

  prune(now = Date.now()) {
    for (const [grantId, record] of this.#records) {
      if (record.grant.status === "issued" && record.grant.expiresAt <= now) {
        this.#transition(record, "expired", now);
      }
      if (record.grant.expiresAt + this.#retentionMs <= now) this.#records.delete(grantId);
    }
  }
}
