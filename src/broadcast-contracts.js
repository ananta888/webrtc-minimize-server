import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

export const MAX_BROADCAST_CONTRACT_BYTES = 32 * 1024;

export const BROADCAST_CONTRACT_SCHEMA_FILES = Object.freeze({
  "broadcast-program": "broadcast-program.v1.schema.json",
  "program-source": "program-source.v1.schema.json",
  publication: "publication.v1.schema.json",
  rendition: "rendition.v1.schema.json",
  "delivery-endpoint": "delivery-endpoint.v1.schema.json",
  "provider-capability": "provider-capability.v1.schema.json",
  consent: "consent.v1.schema.json",
  lease: "lease.v1.schema.json",
  grant: "grant.v1.schema.json",
  "viewer-policy": "viewer-policy.v1.schema.json",
  "caption-track": "caption-track.v1.schema.json",
  health: "health.v1.schema.json",
  event: "event.v1.schema.json",
});

const SCHEMA_ROOT = new URL("../contracts/broadcast/", import.meta.url);
const COMMON_SCHEMA_FILE = "common.v1.schema.json";
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(readFileSync(new URL(COMMON_SCHEMA_FILE, SCHEMA_ROOT), "utf8")));

const validators = new Map(Object.entries(BROADCAST_CONTRACT_SCHEMA_FILES).map(([type, file]) => {
  const schema = JSON.parse(readFileSync(new URL(file, SCHEMA_ROOT), "utf8"));
  return [type, ajv.compile(schema)];
}));

const CONTEXT_FIELDS = new Set([
  "tenantId",
  "roomId",
  "programId",
  "programEpoch",
  "allowedSubjectRefs",
  "allowedPrincipalRefs",
  "requireFresh",
]);

const SUBJECT_FIELDS = Object.freeze([
  "ownerSubjectRef",
  "subjectRef",
  "operatorSubjectRef",
  "grantorSubjectRef",
  "issuerSubjectRef",
  "sourceSubjectRef",
  "reporterSubjectRef",
  "actorSubjectRef",
]);

const PRINCIPAL_FIELDS = Object.freeze(["granteeRef", "holderRef", "audienceRef"]);

const FORBIDDEN_CONTENT_FIELDS = new Set([
  "token",
  "tokens",
  "accessToken",
  "refreshToken",
  "secret",
  "sharedSecret",
  "privateKey",
  "sdp",
  "ice",
  "candidate",
  "candidates",
  "captionText",
  "transcript",
  "payload",
  "mediaBytes",
  "mediaData",
  "url",
  "playbackUrl",
  "publishUrl",
]);

export const BROADCAST_CONTRACT_IDENTITY_FIELDS = Object.freeze({
  "broadcast-program": "programId",
  "program-source": "sourceId",
  publication: "publicationId",
  rendition: "renditionId",
  "delivery-endpoint": "endpointId",
  "provider-capability": "capabilityId",
  consent: "consentId",
  lease: "leaseId",
  grant: "grantId",
  "viewer-policy": "policyId",
  "caption-track": "captionTrackId",
  health: "componentRef",
  event: "eventId",
});

export class BroadcastContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new BroadcastContractError(code);
}

function assertContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)
    || Object.keys(context).some((field) => !CONTEXT_FIELDS.has(field))) {
    fail("invalid_broadcast_context");
  }
  for (const field of ["allowedSubjectRefs", "allowedPrincipalRefs"]) {
    if (context[field] !== undefined && (
      !Array.isArray(context[field])
      || context[field].some((value) => typeof value !== "string")
      || new Set(context[field]).size !== context[field].length
    )) fail("invalid_broadcast_context");
  }
  if (context.requireFresh !== undefined && typeof context.requireFresh !== "boolean") {
    fail("invalid_broadcast_context");
  }
}

function rawBytes(raw) {
  if (typeof raw === "string") return Buffer.byteLength(raw);
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return raw.byteLength;
  fail("invalid_broadcast_json");
}

function parseRaw(raw) {
  if (rawBytes(raw) > MAX_BROADCAST_CONTRACT_BYTES) fail("broadcast_contract_too_large");
  try {
    const value = JSON.parse(Buffer.isBuffer(raw) || raw instanceof Uint8Array
      ? Buffer.from(raw).toString("utf8")
      : raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("invalid_broadcast_contract");
    }
    return value;
  } catch (error) {
    if (error instanceof BroadcastContractError) throw error;
    fail("invalid_broadcast_json");
  }
}

function cloneJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_broadcast_contract");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid_broadcast_contract");
  }
  if (serialized === undefined) fail("invalid_broadcast_contract");
  return parseRaw(serialized);
}

function assertNoContentFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoContentFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, item] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_FIELDS.has(field)) fail("forbidden_broadcast_content_field");
    assertNoContentFields(item);
  }
}

function assertOrder(value, earlier, later) {
  if (value[earlier] !== undefined && value[later] !== undefined && value[earlier] > value[later]) {
    fail("invalid_broadcast_time_order");
  }
}

function assertTimes(value, now, requireFresh) {
  for (const [earlier, later] of [
    ["createdAt", "updatedAt"],
    ["createdAt", "endedAt"],
    ["observedAt", "expiresAt"],
    ["grantedAt", "expiresAt"],
    ["grantedAt", "revokedAt"],
    ["acquiredAt", "renewedAt"],
    ["renewedAt", "expiresAt"],
    ["acquiredAt", "releasedAt"],
    ["issuedAt", "notBefore"],
    ["notBefore", "expiresAt"],
    ["notBefore", "consumedAt"],
    ["issuedAt", "revokedAt"],
  ]) assertOrder(value, earlier, later);

  if (!requireFresh) return;
  const expiresWhileActive = (
    value.type === "provider-capability"
    || value.type === "health"
    || (value.type === "consent" && value.status === "active")
    || (value.type === "lease" && value.status === "active")
    || (value.type === "grant" && value.status === "issued")
    || (value.type === "delivery-endpoint" && value.expiresAt !== undefined
      && new Set(["provisioning", "ready", "active"]).has(value.state))
  );
  if (expiresWhileActive && value.expiresAt <= now) fail("expired_broadcast_contract");
  if (value.type === "grant" && value.status === "issued" && value.notBefore > now) {
    fail("broadcast_grant_not_yet_valid");
  }
}

function assertBinding(value, context) {
  for (const field of ["tenantId", "roomId", "programId", "programEpoch"]) {
    if (context[field] !== undefined && value[field] !== undefined && value[field] !== context[field]) {
      fail(`broadcast_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
    }
  }
  if (context.allowedSubjectRefs) {
    const allowed = new Set(context.allowedSubjectRefs);
    for (const field of SUBJECT_FIELDS) {
      if (value[field] !== undefined && !allowed.has(value[field])) fail("broadcast_subject_mismatch");
    }
  }
  if (context.allowedPrincipalRefs) {
    const allowed = new Set(context.allowedPrincipalRefs);
    for (const field of PRINCIPAL_FIELDS) {
      if (value[field] !== undefined && !allowed.has(value[field])) fail("broadcast_principal_mismatch");
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateObject(value, context, now) {
  assertContext(context);
  if (value.contractVersion !== 1) fail("unsupported_broadcast_contract_version");
  const validator = validators.get(value.type);
  if (!validator) fail("unknown_broadcast_contract_type");
  if (!validator(value)) fail("invalid_broadcast_contract");
  assertNoContentFields(value);
  assertBinding(value, context);
  assertTimes(value, now, context.requireFresh !== false);
  return deepFreeze(value);
}

export function parseBroadcastContract(raw, context = {}, now = Date.now()) {
  return validateObject(parseRaw(raw), context, now);
}

export function validateBroadcastContract(value, context = {}, now = Date.now()) {
  return validateObject(cloneJsonObject(value), context, now);
}

export function broadcastContractId(value) {
  return value?.[BROADCAST_CONTRACT_IDENTITY_FIELDS[value?.type]];
}
