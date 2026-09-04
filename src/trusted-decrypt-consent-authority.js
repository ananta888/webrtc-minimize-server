import crypto from "node:crypto";

const IDS = Object.freeze({
  request: /^[A-Za-z0-9_-]{16,64}$/,
  consent: /^cns_[A-Za-z0-9_-]{16,64}$/,
  tenant: /^tn_[A-Za-z0-9_-]{16,64}$/,
  subject: /^sub_[A-Za-z0-9_-]{16,64}$/,
  packager: /^pkr_[A-Za-z0-9_-]{16,64}$/,
  device: /^dev_[A-Za-z0-9_-]{16,64}$/,
  program: /^prg_[A-Za-z0-9_-]{16,64}$/,
  source: /^src_[A-Za-z0-9_-]{16,64}$/,
  room: /^[a-z0-9][a-z0-9-]{5,47}$/,
});
const SOURCE_KINDS = new Set(["microphone", "camera", "screen", "screen-audio"]);
const REQUEST_FIELDS = new Set([
  "requestVersion", "requestId", "trigger", "tenantId", "roomId", "roomEpoch", "programId",
  "programEpoch", "sourceId", "sourceKind", "purpose", "granteePackagerRef", "granteeDeviceRef", "ttlMs",
]);
const CONTEXT_FIELDS = new Set(["identity", "membership", "packager", "lease", "program"]);
const MAX_TTL_MS = 10 * 60_000;
const REASON_CODES = new Set([
  "user-revoked", "expired", "program-epoch-changed", "room-epoch-changed", "packager-handoff",
  "lease-lost", "room-left", "source-ended", "destroyed",
]);

export class TrustedDecryptConsentError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = "TrustedDecryptConsentError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new TrustedDecryptConsentError(code, status);
}

function object(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.has(field))) fail(code, 400);
  return value;
}

function positive(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, 400);
  return value;
}

function clone(value, code) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(code, 400); }
  if (!encoded || Buffer.byteLength(encoded) > 32 * 1024) fail(code, 400);
  try { return JSON.parse(encoded); } catch { return fail(code, 400); }
}

function normalizeRequest(input) {
  const value = object(clone(input, "invalid_trusted_decrypt_request"), REQUEST_FIELDS,
    "invalid_trusted_decrypt_request");
  if (value.requestVersion !== 1 || !IDS.request.test(value.requestId || "")
    || value.trigger !== "user-action" || !IDS.tenant.test(value.tenantId || "")
    || !IDS.room.test(value.roomId || "") || !IDS.program.test(value.programId || "")
    || !IDS.source.test(value.sourceId || "") || !SOURCE_KINDS.has(value.sourceKind)
    || value.purpose !== "broadcast-program" || !IDS.packager.test(value.granteePackagerRef || "")
    || !IDS.device.test(value.granteeDeviceRef || "")) fail("invalid_trusted_decrypt_request", 400);
  positive(value.roomEpoch, "invalid_trusted_decrypt_request");
  positive(value.programEpoch, "invalid_trusted_decrypt_request");
  if (!Number.isSafeInteger(value.ttlMs) || value.ttlMs < 5_000 || value.ttlMs > MAX_TTL_MS) {
    fail("invalid_trusted_decrypt_request", 400);
  }
  return Object.freeze(value);
}

function authorize(request, rawContext, now) {
  const context = object(clone(rawContext, "invalid_trusted_decrypt_context"), CONTEXT_FIELDS,
    "invalid_trusted_decrypt_context");
  const identity = object(context.identity, new Set(["authenticated", "tenantId", "subjectRef"]),
    "invalid_trusted_decrypt_identity");
  if (identity.authenticated !== true || identity.tenantId !== request.tenantId
    || !IDS.subject.test(identity.subjectRef || "")) fail("trusted_decrypt_authentication_required", 401);
  const membership = object(context.membership,
    new Set(["active", "tenantId", "roomId", "roomEpoch", "subjectRef", "deviceRef", "sources"]),
    "invalid_trusted_decrypt_membership");
  if (membership.active !== true || membership.tenantId !== request.tenantId
    || membership.roomId !== request.roomId || membership.roomEpoch !== request.roomEpoch
    || membership.subjectRef !== identity.subjectRef || !IDS.device.test(membership.deviceRef || "")
    || !Array.isArray(membership.sources) || membership.sources.length > 4) {
    fail("invalid_trusted_decrypt_membership");
  }
  const source = membership.sources.find((candidate) => candidate?.sourceId === request.sourceId);
  if (!source || Object.keys(source).some((field) => !new Set(["sourceId", "sourceKind", "active"]).has(field))
    || source.active !== true || source.sourceKind !== request.sourceKind) fail("trusted_decrypt_source_unauthorized");
  const program = object(context.program,
    new Set(["tenantId", "roomId", "programId", "programEpoch", "state", "sourceIds"]),
    "invalid_trusted_decrypt_program");
  if (program.tenantId !== request.tenantId || program.roomId !== request.roomId
    || program.programId !== request.programId || program.programEpoch !== request.programEpoch
    || !new Set(["preparing", "awaiting_consent", "publishing", "degraded"]).has(program.state)
    || !Array.isArray(program.sourceIds) || !program.sourceIds.includes(request.sourceId)) {
    fail("invalid_trusted_decrypt_program");
  }
  const packager = object(context.packager,
    new Set(["registered", "authorized", "packagerRef", "deviceRef"]), "invalid_trusted_decrypt_packager");
  if (packager.registered !== true || packager.authorized !== true
    || packager.packagerRef !== request.granteePackagerRef || packager.deviceRef !== request.granteeDeviceRef) {
    fail("invalid_trusted_decrypt_packager");
  }
  const lease = object(context.lease,
    new Set(["active", "roomId", "programId", "programEpoch", "holderRef", "deviceRef", "expiresAt"]),
    "invalid_trusted_decrypt_lease");
  if (lease.active !== true || lease.roomId !== request.roomId || lease.programId !== request.programId
    || lease.programEpoch !== request.programEpoch || lease.holderRef !== request.granteePackagerRef
    || lease.deviceRef !== request.granteeDeviceRef || !Number.isSafeInteger(lease.expiresAt)
    || lease.expiresAt <= now) fail("invalid_trusted_decrypt_lease");
  return Object.freeze({ identity, membership, source, program, packager, lease });
}

export class TrustedDecryptConsentAuthority {
  #records = new Map();
  #requests = new Map();
  #audit = [];
  #idFactory;
  #maxRecords;

  constructor({
    idFactory = () => `cns_${crypto.randomBytes(18).toString("base64url")}`,
    maxRecords = 1_024,
  } = {}) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10_000) {
      fail("invalid_trusted_decrypt_configuration", 500);
    }
    this.#idFactory = idFactory;
    this.#maxRecords = maxRecords;
  }

  issue(input, context, now = Date.now()) {
    const request = normalizeRequest(input);
    const requestHash = JSON.stringify(request);
    const previous = this.#requests.get(request.requestId);
    if (previous) {
      if (previous.requestHash !== requestHash) fail("trusted_decrypt_request_replay");
      return this.#records.get(previous.consentId)?.consent || fail("inactive_trusted_decrypt_consent");
    }
    const checked = authorize(request, context, now);
    this.revokeExpired(now);
    for (const record of this.#records.values()) {
      if (record.consent.status === "active" && record.consent.programId === request.programId
        && record.consent.programEpoch === request.programEpoch && record.consent.sourceId === request.sourceId) {
        fail("trusted_decrypt_source_already_consented", 409);
      }
    }
    while (this.#records.size >= this.#maxRecords) {
      const removable = [...this.#records.entries()].find(([, record]) => record.consent.status !== "active");
      if (!removable) fail("trusted_decrypt_consent_quota_reached", 429);
      this.#records.delete(removable[0]);
      this.#requests.delete(removable[1].requestId);
    }
    const expiresAt = Math.min(now + request.ttlMs, checked.lease.expiresAt);
    if (expiresAt - now < 5_000) fail("trusted_decrypt_lease_too_short", 409);
    const consent = Object.freeze({
      version: 1,
      type: "trusted-decrypt-consent",
      trigger: "user-action",
      consentId: this.#idFactory(),
      tenantId: request.tenantId,
      roomId: request.roomId,
      roomEpoch: request.roomEpoch,
      programId: request.programId,
      programEpoch: request.programEpoch,
      grantorSubjectRef: checked.identity.subjectRef,
      granteePackagerRef: request.granteePackagerRef,
      granteeDeviceRef: request.granteeDeviceRef,
      sourceId: request.sourceId,
      sourceKind: request.sourceKind,
      purpose: "broadcast-program",
      status: "active",
      grantedAt: now,
      expiresAt,
    });
    if (!IDS.consent.test(consent.consentId)) {
      fail("invalid_trusted_decrypt_consent_id", 500);
    }
    this.#records.set(consent.consentId, { consent, requestId: request.requestId });
    this.#requests.set(request.requestId, { requestHash, consentId: consent.consentId });
    this.#emit(consent, "consent-granted", "user-action", now);
    return consent;
  }

  revoke(consentId, subjectRef, reasonCode = "user-revoked", now = Date.now()) {
    if (!REASON_CODES.has(reasonCode)) fail("invalid_trusted_decrypt_reason", 400);
    const record = this.#records.get(consentId);
    if (!record) return null;
    if (record.consent.grantorSubjectRef !== subjectRef) fail("trusted_decrypt_revoke_forbidden");
    if (record.consent.status === "revoked") return record.consent;
    const consent = Object.freeze({ ...record.consent, status: "revoked", revokedAt: now });
    record.consent = consent;
    this.#emit(consent, "consent-revoked", reasonCode, now);
    return consent;
  }

  revokeScope({ roomId, roomEpoch, programId, programEpoch, granteeDeviceRef, reasonCode }, now = Date.now()) {
    if (!IDS.room.test(roomId || "") || !positive(roomEpoch, "invalid_trusted_decrypt_scope")
      || !IDS.program.test(programId || "") || !positive(programEpoch, "invalid_trusted_decrypt_scope")
      || !IDS.device.test(granteeDeviceRef || "") || !REASON_CODES.has(reasonCode)) {
      fail("invalid_trusted_decrypt_scope", 400);
    }
    for (const record of this.#records.values()) {
      const value = record.consent;
      if (value.status === "active" && value.roomId === roomId
        && (value.roomEpoch !== roomEpoch || value.programId !== programId
          || value.programEpoch !== programEpoch || value.granteeDeviceRef !== granteeDeviceRef)) {
        this.revoke(value.consentId, value.grantorSubjectRef, reasonCode, now);
      }
    }
  }

  revokeExpired(now = Date.now()) {
    for (const record of this.#records.values()) {
      if (record.consent.status === "active" && record.consent.expiresAt <= now) {
        this.revoke(record.consent.consentId, record.consent.grantorSubjectRef, "expired", now);
      }
    }
  }

  list(subjectRef, now = Date.now()) {
    this.revokeExpired(now);
    return Object.freeze([...this.#records.values()].map(({ consent }) => consent)
      .filter((consent) => consent.grantorSubjectRef === subjectRef));
  }

  auditEvents() {
    return Object.freeze([...this.#audit]);
  }

  #emit(consent, eventType, reasonCode, occurredAt) {
    this.#audit.push(Object.freeze({
      eventVersion: 1, eventType, consentId: consent.consentId, tenantId: consent.tenantId,
      roomId: consent.roomId, roomEpoch: consent.roomEpoch, programId: consent.programId,
      programEpoch: consent.programEpoch, grantorSubjectRef: consent.grantorSubjectRef,
      granteePackagerRef: consent.granteePackagerRef, granteeDeviceRef: consent.granteeDeviceRef,
      sourceId: consent.sourceId, sourceKind: consent.sourceKind, purpose: consent.purpose,
      occurredAt, reasonCode,
    }));
    if (this.#audit.length > 512) this.#audit.splice(0, this.#audit.length - 512);
  }
}
