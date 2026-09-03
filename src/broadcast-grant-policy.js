import crypto from "node:crypto";

import {
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";
import {
  broadcastSubjectRef,
  broadcastTenantRef,
  oidcPrincipal,
} from "./broadcast-identifiers.js";

export const BROADCAST_GRANT_AUDIENCE = Object.freeze({
  publisher: "broadcast-publisher",
  packager: "broadcast-packager",
  playback: "broadcast-playback",
});

const GRANT_KINDS = new Set(["publisher", "packager", "playback"]);
const KIND_ACTIONS = Object.freeze({
  publisher: new Set(["whip:create", "whip:update", "whip:delete", "moq:publish"]),
  packager: new Set(["whip:create", "whip:update", "whip:delete", "moq:publish"]),
  playback: new Set(["playback:manifest", "playback:segment", "whep:read", "moq:subscribe"]),
});
const KIND_ROLES = Object.freeze({
  publisher: new Set(["owner", "moderator", "presenter"]),
  packager: new Set(["owner", "moderator", "packager"]),
  playback: new Set(["owner", "moderator", "presenter", "viewer"]),
});
const PROGRAM_STATES = Object.freeze({
  publisher: new Set(["preparing", "publishing", "degraded"]),
  packager: new Set(["preparing", "publishing", "degraded"]),
  playback: new Set(["live", "degraded"]),
});
const REQUIRED_CONSENT_ACTIONS = Object.freeze([
  "decrypt-source",
  "compose-program",
  "publish-program",
]);
const REQUEST_FIELDS = new Set([
  "grantVersion",
  "kind",
  "roomId",
  "programId",
  "programRevision",
  "programEpoch",
  "audienceRef",
  "actions",
  "resourceRef",
  "pathPrefix",
  "policyId",
  "policyRevision",
  "deviceProof",
]);
const AUTHORIZATION_FIELDS = new Set([
  "identity",
  "membership",
  "grantee",
  "program",
  "consents",
  "viewerPolicy",
]);
const EXPECTED_FIELDS = new Set([
  "audience",
  "action",
  "tenantId",
  "subjectRef",
  "audienceRef",
  "deviceRef",
  "roomId",
  "programId",
  "programRevision",
  "programEpoch",
  "resourceRef",
  "path",
  "policyId",
  "policyRevision",
]);
const PRINCIPAL_REF = /^(sub|pkr)_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE_REF = /^res_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_REF = /^dev_[A-Za-z0-9_-]{16,64}$/;

export class BroadcastGrantError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = "BroadcastGrantError";
    this.code = code;
    this.status = status;
  }
}

export function broadcastGrantFail(code, status) {
  throw new BroadcastGrantError(code, status);
}

function assertPlainObject(value, code = "invalid_broadcast_grant_request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) broadcastGrantFail(code, 400);
}

function assertClosed(value, allowed, code = "invalid_broadcast_grant_request") {
  assertPlainObject(value, code);
  if (Object.keys(value).some((field) => !allowed.has(field))) broadcastGrantFail(code, 400);
}

function positiveInteger(value, code = "invalid_broadcast_grant_request") {
  if (!Number.isSafeInteger(value) || value < 1) broadcastGrantFail(code, 400);
  return value;
}

function cloneJson(value, code, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    broadcastGrantFail(code, 400);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes) {
    broadcastGrantFail(code, 400);
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return broadcastGrantFail(code, 400);
  }
}

export function normalizeBroadcastGrantPath(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 256
    || !value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f?#]/.test(value)
    || value.includes("//") || /%2f|%5c/i.test(value)) {
    broadcastGrantFail("invalid_broadcast_grant_path", 400);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    broadcastGrantFail("invalid_broadcast_grant_path", 400);
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    broadcastGrantFail("invalid_broadcast_grant_path", 400);
  }
  return value.length > 2 ? value.replace(/\/+$/, "") : value;
}

export function broadcastGrantPathHash(pathPrefix) {
  const normalized = normalizeBroadcastGrantPath(pathPrefix);
  return crypto.createHash("sha256").update(`path-prefix-v1\0${normalized}`).digest("hex");
}

export function broadcastGrantPathMatches(path, prefix) {
  const normalized = normalizeBroadcastGrantPath(path);
  return normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function normalizeActions(kind, values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8
    || (kind !== "playback" && values.length !== 1)
    || values.some((action) => !KIND_ACTIONS[kind].has(action))) {
    broadcastGrantFail("invalid_broadcast_grant_actions", 400);
  }
  const actions = [...new Set(values)].sort();
  if (actions.length !== values.length) broadcastGrantFail("invalid_broadcast_grant_actions", 400);
  return Object.freeze(actions);
}

export function normalizeBroadcastGrantRequest(value) {
  const request = cloneJson(value, "invalid_broadcast_grant_request", 64 * 1024);
  assertClosed(request, REQUEST_FIELDS);
  if (request.grantVersion !== 1 || !GRANT_KINDS.has(request.kind)
    || typeof request.roomId !== "string" || typeof request.programId !== "string"
    || !PRINCIPAL_REF.test(request.audienceRef || "")
    || !RESOURCE_REF.test(request.resourceRef || "")) {
    broadcastGrantFail("invalid_broadcast_grant_request", 400);
  }
  positiveInteger(request.programRevision);
  positiveInteger(request.programEpoch);
  request.actions = normalizeActions(request.kind, request.actions);
  request.pathPrefix = normalizeBroadcastGrantPath(request.pathPrefix);
  if (request.kind === "playback") {
    if (typeof request.policyId !== "string") broadcastGrantFail("invalid_broadcast_grant_policy", 400);
    positiveInteger(request.policyRevision, "invalid_broadcast_grant_policy");
  } else if (request.policyId !== undefined || request.policyRevision !== undefined) {
    broadcastGrantFail("invalid_broadcast_grant_policy", 400);
  }
  assertPlainObject(request.deviceProof, "broadcast_device_proof_required");
  return Object.freeze(request);
}

function checkedContract(value, context, now) {
  try {
    return validateBroadcastContract(value, context, now);
  } catch (error) {
    if (error instanceof BroadcastContractError) broadcastGrantFail(error.code);
    throw error;
  }
}

function normalizeIdentity(value, config, now) {
  assertPlainObject(value, "broadcast_authentication_required");
  const allowed = new Set([
    "issuer", "subject", "audience", "algorithm", "issuedAt", "expiresAt", "displayName",
  ]);
  if (Object.keys(value).some((field) => !allowed.has(field))
    || value.issuer !== config.oidcIssuer || value.audience !== config.oidcAudience
    || !config.oidcAlgorithms.has(value.algorithm)
    || typeof value.subject !== "string" || value.subject.length < 1 || value.subject.length > 1024
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
    || (value.issuedAt !== undefined && (!Number.isSafeInteger(value.issuedAt) || value.issuedAt > now + 30_000))) {
    broadcastGrantFail("invalid_broadcast_oidc_identity");
  }
  return value;
}

function normalizeMembership(value, refs, roomId, kind) {
  assertClosed(value, new Set([
    "active", "tenantId", "roomId", "subjectRef", "principal", "role", "deviceFingerprint",
  ]), "invalid_broadcast_membership");
  if (value.active !== true || value.tenantId !== refs.tenantId || value.roomId !== roomId
    || value.subjectRef !== refs.subjectRef || value.principal !== refs.principal
    || !KIND_ROLES[kind].has(value.role)
    || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint || "")) {
    broadcastGrantFail("invalid_broadcast_membership");
  }
  return value;
}

function normalizeGrantee(value, request, subjectRef) {
  assertClosed(value, new Set([
    "authorized", "audienceRef", "ownerSubjectRef", "deviceFingerprint",
  ]), "invalid_broadcast_grantee");
  if (value.authorized !== true || value.audienceRef !== request.audienceRef
    || value.ownerSubjectRef !== subjectRef
    || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint || "")) {
    broadcastGrantFail("invalid_broadcast_grantee");
  }
  return value;
}

function assertProgram(program, request, tenantId) {
  if (program.tenantId !== tenantId || program.roomId !== request.roomId
    || program.programId !== request.programId || program.revision !== request.programRevision
    || program.programEpoch !== request.programEpoch) broadcastGrantFail("broadcast_grant_program_mismatch");
  if (!PROGRAM_STATES[request.kind].has(program.state)) {
    broadcastGrantFail("invalid_broadcast_grant_program_state");
  }
}

function assertPackagerConsents(consents, request, tenantId, sourceIds, now) {
  if (!Array.isArray(consents)) broadcastGrantFail("broadcast_packager_consent_required");
  const covered = new Set();
  for (const value of consents) {
    const consent = checkedContract(value, {
      tenantId,
      roomId: request.roomId,
      programId: request.programId,
      programEpoch: request.programEpoch,
      requireFresh: true,
    }, now);
    if (consent.type !== "consent" || consent.status !== "active"
      || consent.granteeRef !== request.audienceRef
      || REQUIRED_CONSENT_ACTIONS.some((action) => !consent.actions.includes(action))) continue;
    for (const sourceId of consent.sourceIds) covered.add(sourceId);
  }
  if (sourceIds.some((sourceId) => !covered.has(sourceId))) {
    broadcastGrantFail("broadcast_packager_consent_required");
  }
}

function assertViewerPolicy(value, request, tenantId, program, now) {
  const policy = checkedContract(value, {
    tenantId,
    roomId: request.roomId,
    programId: request.programId,
    programEpoch: request.programEpoch,
    requireFresh: false,
  }, now);
  if (policy.type !== "viewer-policy" || policy.policyId !== request.policyId
    || policy.revision !== request.policyRevision || policy.visibility !== program.visibility) {
    broadcastGrantFail("broadcast_grant_policy_mismatch");
  }
  return policy;
}

export function authorizeBroadcastGrantRequest(request, authorization, config, now) {
  const context = cloneJson(authorization, "invalid_broadcast_grant_authorization", 128 * 1024);
  assertClosed(context, AUTHORIZATION_FIELDS, "invalid_broadcast_grant_authorization");
  const identity = normalizeIdentity(context.identity, config, now);
  const refs = Object.freeze({
    tenantId: broadcastTenantRef(identity.issuer),
    subjectRef: broadcastSubjectRef(identity),
    principal: oidcPrincipal(identity),
  });
  const membership = normalizeMembership(context.membership, refs, request.roomId, request.kind);
  const grantee = normalizeGrantee(context.grantee, request, refs.subjectRef);
  const program = checkedContract(context.program, {
    tenantId: refs.tenantId,
    roomId: request.roomId,
    programId: request.programId,
    programEpoch: request.programEpoch,
    requireFresh: false,
  }, now);
  if (program.type !== "broadcast-program") broadcastGrantFail("invalid_broadcast_grant_program");
  assertProgram(program, request, refs.tenantId);
  if (request.kind === "packager") {
    assertPackagerConsents(context.consents, request, refs.tenantId, program.sourceIds || [], now);
  } else if (context.consents !== undefined && context.consents !== null) {
    broadcastGrantFail("unexpected_broadcast_grant_consent", 400);
  }
  const viewerPolicy = request.kind === "playback"
    ? assertViewerPolicy(context.viewerPolicy, request, refs.tenantId, program, now)
    : null;
  if (request.kind !== "playback" && context.viewerPolicy !== undefined && context.viewerPolicy !== null) {
    broadcastGrantFail("unexpected_broadcast_viewer_policy", 400);
  }
  return Object.freeze({ identity, refs, membership, grantee, program, viewerPolicy });
}

export function normalizeBroadcastGrantExpectation(value) {
  const expected = cloneJson(value, "invalid_broadcast_grant_expectation", 16 * 1024);
  assertClosed(expected, EXPECTED_FIELDS, "invalid_broadcast_grant_expectation");
  const required = [
    "audience", "action", "tenantId", "subjectRef", "audienceRef", "deviceRef", "roomId",
    "programId", "programRevision", "programEpoch", "resourceRef", "path",
  ];
  if (required.some((field) => expected[field] === undefined)
    || !Object.values(BROADCAST_GRANT_AUDIENCE).includes(expected.audience)
    || !PRINCIPAL_REF.test(expected.audienceRef || "")
    || !DEVICE_REF.test(expected.deviceRef || "")
    || !RESOURCE_REF.test(expected.resourceRef || "")) {
    broadcastGrantFail("invalid_broadcast_grant_expectation", 400);
  }
  positiveInteger(expected.programRevision, "invalid_broadcast_grant_expectation");
  positiveInteger(expected.programEpoch, "invalid_broadcast_grant_expectation");
  expected.path = normalizeBroadcastGrantPath(expected.path);
  if ((expected.policyId === undefined) !== (expected.policyRevision === undefined)) {
    broadcastGrantFail("invalid_broadcast_grant_expectation", 400);
  }
  if (expected.policyRevision !== undefined) {
    positiveInteger(expected.policyRevision, "invalid_broadcast_grant_expectation");
  }
  return Object.freeze(expected);
}
