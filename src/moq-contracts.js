import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

export const MOQ_PROTOCOL_PINS = Object.freeze({
  transport: "draft-ietf-moq-transport-20",
  loc: "draft-ietf-moq-loc-04",
  webTransport: "RFC 9297",
  secureObjects: "draft-ietf-moq-secure-objects-01",
});

export const MAX_MOQ_CATALOG_BYTES = 64 * 1024;
export const MAX_MOQ_CONTROL_BYTES = 16 * 1024;
export const MAX_MOQ_OBJECT_BYTES = 1024 * 1024;

export const MOQ_CONTRACT_SCHEMA_FILES = Object.freeze({
  "moq-capability": "capability.v1.schema.json",
  "moq-catalog": "catalog.v1.schema.json",
  "moq-object": "object.v1.schema.json",
  "moq-subscription": "subscription.v1.schema.json",
});

const SCHEMA_ROOT = new URL("../contracts/moq/", import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(readFileSync(new URL("common.v1.schema.json", SCHEMA_ROOT), "utf8")));
const validators = new Map(Object.entries(MOQ_CONTRACT_SCHEMA_FILES).map(([type, file]) => [
  type,
  ajv.compile(JSON.parse(readFileSync(new URL(file, SCHEMA_ROOT), "utf8"))),
]));

const CONTEXT_FIELDS = new Set([
  "tenantId", "programId", "programEpoch", "audienceId", "namespace", "requireFresh",
]);
const POLICY_FIELDS = new Set([
  "moqEnabled", "requireSecureObjects", "preferredCodecs", "allowedFallbackProtocols",
]);

export class MoqContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "MoqContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new MoqContractError(code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_moq_contract");
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid_moq_contract");
  }
  if (serialized === undefined) fail("invalid_moq_contract");
  return parseRaw(serialized);
}

function parseRaw(raw) {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
    fail("invalid_moq_json");
  }
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes > MAX_MOQ_CATALOG_BYTES) fail("moq_contract_too_large");
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_moq_contract");
    return { value, bytes };
  } catch (error) {
    if (error instanceof MoqContractError) throw error;
    fail("invalid_moq_json");
  }
}

export function createMoqNamespace({ tenantId, programId, programEpoch }) {
  if (typeof tenantId !== "string" || typeof programId !== "string"
    || !Number.isSafeInteger(programEpoch) || programEpoch < 1) {
    fail("invalid_moq_namespace_scope");
  }
  return `${tenantId}/${programId}/epoch/${programEpoch}`;
}

function assertContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)
    || Object.keys(context).some((field) => !CONTEXT_FIELDS.has(field))
    || (context.requireFresh !== undefined && typeof context.requireFresh !== "boolean")) {
    fail("invalid_moq_context");
  }
}

function assertScope(value, context) {
  for (const field of ["tenantId", "programId", "programEpoch", "audienceId", "namespace"]) {
    if (context[field] !== undefined && value[field] !== context[field]) {
      fail(`moq_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
    }
  }
  if (value.namespace !== undefined) {
    const expected = createMoqNamespace(value);
    if (value.namespace !== expected) fail("moq_namespace_mismatch");
  }
}

function assertSemantics(value, bytes, now, requireFresh) {
  const maxBytes = value.type === "moq-catalog" ? MAX_MOQ_CATALOG_BYTES : MAX_MOQ_CONTROL_BYTES;
  if (bytes > maxBytes) fail(value.type === "moq-catalog" ? "moq_catalog_too_large" : "moq_contract_too_large");
  if (value.createdAt !== undefined && value.createdAt > value.expiresAt) fail("invalid_moq_time_order");
  if (value.observedAt !== undefined && value.observedAt > value.expiresAt) fail("invalid_moq_time_order");
  if (requireFresh && value.expiresAt <= now) fail("expired_moq_contract");

  if (value.type === "moq-capability") {
    const prefix = { browser: "brw_", gateway: "gtw_", provider: "prv_" }[value.participantKind];
    if (!value.participantRef.startsWith(prefix)) fail("moq_participant_kind_mismatch");
  }
  if (value.type === "moq-catalog") {
    if (new Set(value.tracks.map((track) => track.trackName)).size !== value.tracks.length) {
      fail("duplicate_moq_track");
    }
  }
  if (value.type === "moq-subscription" && value.filter.mode === "absolute-range") {
    const start = [value.filter.startGroup, value.filter.startObject];
    const end = [value.filter.endGroup, value.filter.endObject];
    if (end[0] < start[0] || (end[0] === start[0] && end[1] < start[1])) {
      fail("invalid_moq_subscription_range");
    }
  }
}

function validateParsed(value, bytes, context, now) {
  assertContext(context);
  if (value.contractVersion !== 1) fail("unsupported_moq_contract_version");
  const validator = validators.get(value.type);
  if (!validator) fail("unknown_moq_contract_type");
  if (!validator(value)) fail("invalid_moq_contract");
  assertScope(value, context);
  assertSemantics(value, bytes, now, context.requireFresh !== false);
  return deepFreeze(value);
}

export function parseMoqContract(raw, context = {}, now = Date.now()) {
  const { value, bytes } = parseRaw(raw);
  return validateParsed(value, bytes, context, now);
}

export function validateMoqContract(value, context = {}, now = Date.now()) {
  const { value: cloned, bytes } = cloneJson(value);
  return validateParsed(cloned, bytes, context, now);
}

export function validateMoqObjectPayload(metadata, payload, context = {}, now = Date.now()) {
  const object = validateMoqContract(metadata, context, now);
  if (object.type !== "moq-object") fail("invalid_moq_object_contract");
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) fail("invalid_moq_object_payload");
  if (payload.byteLength > MAX_MOQ_OBJECT_BYTES) fail("moq_object_too_large");
  if (payload.byteLength !== object.payloadBytes) fail("moq_object_size_mismatch");
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== object.payloadSha256) fail("moq_object_digest_mismatch");
  return object;
}

export function authorizeMoqSubscription(subscriptionValue, catalogValue, context = {}, now = Date.now()) {
  const subscription = validateMoqContract(subscriptionValue, context, now);
  const catalog = validateMoqContract(catalogValue, context, now);
  if (subscription.type !== "moq-subscription" || catalog.type !== "moq-catalog") {
    fail("invalid_moq_subscription_binding");
  }
  for (const field of ["tenantId", "programId", "programEpoch", "audienceId", "namespace"]) {
    if (subscription[field] !== catalog[field]) fail(`moq_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
  }
  const track = catalog.tracks.find((candidate) => candidate.trackName === subscription.trackName);
  if (!track) fail("unknown_moq_track");
  if (!subscription.codecPreferences.includes(track.codec)
    || !subscription.renditionIds.includes(track.renditionId)) {
    fail("moq_subscription_rendition_denied");
  }
  return deepFreeze({ subscription, track });
}

function intersection(capabilities, field) {
  const [first, ...rest] = capabilities.map((capability) => capability[field]);
  return first.filter((candidate) => rest.every((values) => values.includes(candidate)));
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
    || Object.keys(policy).some((field) => !POLICY_FIELDS.has(field))
    || typeof policy.moqEnabled !== "boolean"
    || typeof policy.requireSecureObjects !== "boolean"
    || !Array.isArray(policy.preferredCodecs) || policy.preferredCodecs.length < 1
    || policy.preferredCodecs.length > 6 || new Set(policy.preferredCodecs).size !== policy.preferredCodecs.length
    || policy.preferredCodecs.some((codec) => !["opus", "aac", "vp8", "vp9", "h264", "av1"].includes(codec))
    || !Array.isArray(policy.allowedFallbackProtocols) || policy.allowedFallbackProtocols.length < 1
    || policy.allowedFallbackProtocols.length > 2
    || policy.allowedFallbackProtocols.some((protocol) => !["ll-hls", "hls"].includes(protocol))) {
    fail("invalid_moq_negotiation_policy");
  }
}

function fallback(capabilities, policy, reasonCode) {
  const supported = intersection(capabilities, "fallbackProtocols");
  const fallbackProtocol = policy.allowedFallbackProtocols.find((protocol) => supported.includes(protocol));
  if (!fallbackProtocol) fail("moq_fallback_unavailable");
  const scope = capabilities[0];
  return deepFreeze({
    transport: fallbackProtocol,
    experimental: false,
    reasonCode,
    tenantId: scope.tenantId,
    programId: scope.programId,
    programEpoch: scope.programEpoch,
    audienceId: scope.audienceId,
  });
}

export function negotiateMoqCapabilities(capabilityValues, policy, context = {}, now = Date.now()) {
  validatePolicy(policy);
  if (!Array.isArray(capabilityValues) || capabilityValues.length !== 3) {
    fail("invalid_moq_capability_set");
  }
  const capabilities = capabilityValues.map((value) => validateMoqContract(
    value,
    { ...context, requireFresh: false },
    now,
  ));
  const kinds = new Set(capabilities.map((value) => value.participantKind));
  if (kinds.size !== 3 || !["browser", "gateway", "provider"].every((kind) => kinds.has(kind))) {
    fail("invalid_moq_capability_set");
  }
  const scope = capabilities[0];
  for (const capability of capabilities.slice(1)) {
    for (const field of ["tenantId", "programId", "programEpoch", "audienceId"]) {
      if (capability[field] !== scope[field]) fail(`moq_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
    }
  }
  if (!policy.moqEnabled) return fallback(capabilities, policy, "moq_disabled");
  if (capabilities.some((capability) => !capability.enabled || capability.expiresAt <= now)) {
    return fallback(capabilities, policy, "moq_capability_unavailable");
  }
  const hasPin = (field, pin) => capabilities.every((capability) => capability[field].includes(pin));
  if (!hasPin("transportVersions", MOQ_PROTOCOL_PINS.transport)
    || !hasPin("locVersions", MOQ_PROTOCOL_PINS.loc)
    || !hasPin("webTransportVersions", MOQ_PROTOCOL_PINS.webTransport)) {
    return fallback(capabilities, policy, "moq_version_mismatch");
  }
  if (policy.requireSecureObjects
    && !hasPin("secureObjectVersions", MOQ_PROTOCOL_PINS.secureObjects)) {
    return fallback(capabilities, policy, "moq_secure_objects_unavailable");
  }
  const codecs = intersection(capabilities, "codecs");
  const codec = policy.preferredCodecs.find((candidate) => codecs.includes(candidate));
  if (!codec) return fallback(capabilities, policy, "moq_codec_unavailable");
  return deepFreeze({
    transport: "moq",
    experimental: true,
    reasonCode: "moq_compatible",
    tenantId: scope.tenantId,
    programId: scope.programId,
    programEpoch: scope.programEpoch,
    audienceId: scope.audienceId,
    moqtVersion: MOQ_PROTOCOL_PINS.transport,
    locVersion: MOQ_PROTOCOL_PINS.loc,
    webTransportVersion: MOQ_PROTOCOL_PINS.webTransport,
    secureObjectsVersion: policy.requireSecureObjects ? MOQ_PROTOCOL_PINS.secureObjects : null,
    codec,
    maxCatalogBytes: Math.min(...capabilities.map((value) => value.maxCatalogBytes)),
    maxObjectBytes: Math.min(...capabilities.map((value) => value.maxObjectBytes)),
  });
}
