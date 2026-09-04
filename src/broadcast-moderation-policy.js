import {
  BroadcastAudienceError,
  authorizeBroadcastRoleAction,
  normalizeBroadcastServerActor,
} from "./broadcast-action-policy.js";
import { validateBroadcastContract } from "./broadcast-contracts.js";
import { BROADCAST_DOMAIN_PATTERNS } from "./broadcast-program-model.js";
import {
  NativePackagerPolicyError,
  admitNativePackager,
  normalizeNativePackagerCapability,
} from "./native-packager-policy.js";

const MAX_ACTION_BYTES = 16 * 1024;
const MAX_AUDIT_RECORDS = 256;
const MAX_CANDIDATES = 16;
const MAX_STANDBYS = 2;
const CONFIRMATION_TTL_MS = 120_000;
const CLOCK_SKEW_MS = 5_000;
const SUBJECT = BROADCAST_DOMAIN_PATTERNS.subjectRef;
const SOURCE = BROADCAST_DOMAIN_PATTERNS.sourceId;
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CONFIRMATION = /^bcf_[A-Za-z0-9_-]{16,64}$/;
const ACTION_ID = /^bma_[A-Za-z0-9_-]{16,64}$/;
const LAYOUTS = new Set([
  "single", "screen-presenter", "side-by-side", "active-speaker", "grid",
  "waiting-slate", "end-slate",
]);
const SOURCE_KINDS = new Set(["microphone", "camera", "screen", "screen-audio"]);
const ACTION_ROLE_MAP = Object.freeze({
  "source-request": "source:request",
  "source-remove": "source:revoke",
  "own-source-revoke": "source:revoke",
  "layout-change": "program:layout",
  "packager-select": "packager:select",
  "packager-standby": "packager:standby",
  "packager-handoff": "packager:handoff",
  "program-stop": "program:stop",
});
const ACTION_FIELDS = Object.freeze({
  "source-request": ["targetSubjectRef", "sourceKind"],
  "source-remove": ["targetSubjectRef", "sourceId", "reasonCode"],
  "own-source-revoke": ["targetSubjectRef", "sourceId", "reasonCode"],
  "layout-change": ["layout"],
  "packager-select": ["primaryAgentId", "standbyAgentIds"],
  "packager-standby": ["standbyAgentIds"],
  "packager-handoff": ["primaryAgentId", "expectedLeaseEpoch"],
  "program-stop": ["reasonCode"],
});
const COMMON_ACTION_FIELDS = Object.freeze([
  "workflowVersion", "type", "action", "actionId", "trigger", "tenantId", "roomId",
  "programId", "actorSubjectRef", "actorRole", "expectedProgramRevision",
  "expectedProgramEpoch", "confirmation",
]);

export class BroadcastModerationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "BroadcastModerationError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new BroadcastModerationError(code, status); };

function cloneBounded(value, code = "invalid_broadcast_moderation_action") {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return fail(code); }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_ACTION_BYTES) fail(code);
  try { return JSON.parse(serialized); } catch { return fail(code); }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function positiveInteger(value, code = "invalid_broadcast_moderation_action") {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function assertPattern(value, pattern, code = "invalid_broadcast_moderation_action") {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function normalizeConfirmation(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, "confirmationId")
    || !Object.hasOwn(value, "confirmedAt")
    || !Object.hasOwn(value, "expiresAt")
    || !CONFIRMATION.test(value.confirmationId || "")
    || !Number.isSafeInteger(value.confirmedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.confirmedAt > now + CLOCK_SKEW_MS || value.expiresAt <= now
    || value.expiresAt > value.confirmedAt + CONFIRMATION_TTL_MS) {
    fail("invalid_broadcast_moderation_confirmation");
  }
  return value;
}

function normalizeAgentIds(values, allowEmpty = true) {
  if (!Array.isArray(values) || (!allowEmpty && values.length < 1)
    || values.length > MAX_STANDBYS || new Set(values).size !== values.length
    || values.some((value) => typeof value !== "string" || !AGENT.test(value))) {
    fail("invalid_broadcast_packager_selection");
  }
  return values;
}

export function authorizeBroadcastModerationAction(programValue, actorValue, input, now = Date.now()) {
  const program = validateBroadcastContract(programValue, { requireFresh: false }, now);
  if (program.type !== "broadcast-program") fail("invalid_broadcast_program");
  const actor = normalizeBroadcastServerActor(actorValue);
  const action = cloneBounded(input);
  const actionFields = ACTION_FIELDS[action?.action];
  if (!action || typeof action !== "object" || Array.isArray(action) || !actionFields
    || action.workflowVersion !== 1 || action.type !== "broadcast-moderation-action"
    || action.trigger !== "user-action"
    || Object.keys(action).some((field) => !new Set([...COMMON_ACTION_FIELDS, ...actionFields]).has(field))
    || [...COMMON_ACTION_FIELDS, ...actionFields].some((field) => action[field] === undefined)
    || !ACTION_ID.test(action.actionId || "")) {
    fail("invalid_broadcast_moderation_action");
  }
  for (const field of ["tenantId", "roomId", "programId", "actorSubjectRef"]) {
    if (action[field] !== program[field === "actorSubjectRef" ? "ownerSubjectRef" : field]
      && field !== "actorSubjectRef") fail("broadcast_moderation_scope_mismatch", 403);
  }
  if (action.actorSubjectRef !== actor.subjectRef || action.actorRole !== actor.role
    || action.tenantId !== actor.tenantId || action.roomId !== actor.roomId) {
    fail("broadcast_moderation_actor_mismatch", 403);
  }
  if (action.expectedProgramRevision !== program.revision) fail("stale_broadcast_revision", 409);
  if (action.expectedProgramEpoch !== program.programEpoch) fail("stale_broadcast_epoch", 409);
  positiveInteger(action.expectedProgramRevision);
  positiveInteger(action.expectedProgramEpoch);
  normalizeConfirmation(action.confirmation, now);

  let targetSubjectRef;
  if (new Set(["source-request", "source-remove", "own-source-revoke"]).has(action.action)) {
    targetSubjectRef = assertPattern(action.targetSubjectRef, SUBJECT);
  }
  if (new Set(["source-remove", "own-source-revoke"]).has(action.action)) {
    assertPattern(action.sourceId, SOURCE);
    assertPattern(action.reasonCode, BROADCAST_DOMAIN_PATTERNS.reasonCode);
  }
  if (action.action === "source-request" && !SOURCE_KINDS.has(action.sourceKind)) {
    fail("invalid_broadcast_source_request");
  }
  if (action.action === "layout-change" && !LAYOUTS.has(action.layout)) {
    fail("invalid_broadcast_layout");
  }
  if (action.action === "packager-select") {
    assertPattern(action.primaryAgentId, AGENT, "invalid_broadcast_packager_selection");
    normalizeAgentIds(action.standbyAgentIds);
    if (action.standbyAgentIds.includes(action.primaryAgentId)) {
      fail("invalid_broadcast_packager_selection");
    }
  }
  if (action.action === "packager-standby") normalizeAgentIds(action.standbyAgentIds);
  if (action.action === "packager-handoff") {
    assertPattern(action.primaryAgentId, AGENT, "invalid_broadcast_packager_selection");
    positiveInteger(action.expectedLeaseEpoch);
  }
  if (action.action === "program-stop") {
    assertPattern(action.reasonCode, BROADCAST_DOMAIN_PATTERNS.reasonCode);
  }
  if (action.action === "own-source-revoke" && targetSubjectRef !== actor.subjectRef) {
    fail("broadcast_own_source_required", 403);
  }

  try {
    authorizeBroadcastRoleAction(program, actor, ACTION_ROLE_MAP[action.action], {
      expectedEpoch: actor.epoch,
      ...(targetSubjectRef === undefined ? {} : { targetSubjectRef }),
    });
  } catch (error) {
    if (error instanceof BroadcastAudienceError) fail(error.code, error.status);
    throw error;
  }
  return deepFreeze(action);
}

export function summarizeBroadcastSourceConsent(sourceValues, consentValues, context, now = Date.now()) {
  if (!Array.isArray(sourceValues) || sourceValues.length > 20
    || !Array.isArray(consentValues) || consentValues.length > 20) {
    fail("invalid_broadcast_consent_summary");
  }
  const sources = sourceValues.map((source) => validateBroadcastContract(source, context, now));
  const consents = consentValues.map((consent) => validateBroadcastContract(consent, context, now));
  if (sources.some(({ type }) => type !== "program-source")
    || consents.some(({ type }) => type !== "consent")) fail("invalid_broadcast_consent_summary");
  const byId = new Map(consents.map((consent) => [consent.consentId, consent]));
  return deepFreeze(sources.map((source) => {
    const consent = source.consentId ? byId.get(source.consentId) : null;
    return {
      sourceId: source.sourceId,
      subjectRef: source.subjectRef,
      kind: source.kind,
      sourceState: source.state,
      consentState: source.trustMode === "own-source"
        ? "not-required"
        : consent?.status === "active" && consent.expiresAt > now ? "active" : "missing-or-expired",
      expiresAt: consent?.status === "active" ? consent.expiresAt : null,
    };
  }));
}

export function planOwnSourceRevocation(actionValue, sourceValue, context, now = Date.now()) {
  const action = authorizeBroadcastModerationAction(context.program, context.actor, actionValue, now);
  if (action.action !== "own-source-revoke") fail("broadcast_own_source_required", 403);
  const source = validateBroadcastContract(sourceValue, {
    tenantId: context.program.tenantId,
    roomId: context.program.roomId,
    programId: context.program.programId,
    programEpoch: context.program.programEpoch,
    requireFresh: false,
  }, now);
  if (source.type !== "program-source" || source.sourceId !== action.sourceId
    || source.subjectRef !== action.actorSubjectRef) fail("broadcast_own_source_required", 403);
  return deepFreeze({
    planVersion: 1,
    sourceId: source.sourceId,
    programEpoch: context.program.programEpoch,
    replacement: "safe-slate-or-reflow",
    retainLastDecodedFrame: false,
    effects: [
      "fence-source-input",
      "revoke-source-decrypt-key",
      "destroy-source-decoder",
      "clear-compositor-surface",
      "replace-with-safe-slate-or-reflow",
      "revoke-source-grants",
    ],
  });
}

function uploadRank(value) {
  return { "under-5mbit": 1, "5-15mbit": 2, "over-15mbit": 3 }[value] || 0;
}

function candidateScore(capability) {
  const cpu = { low: 10, medium: 20, high: 30 }[capability.cpuClass];
  const upload = uploadRank(capability.uploadClass) * 100;
  const energy = { battery: 0, "ac-limited": 5, ac: 10 }[capability.energyClass];
  const hardware = capability.gpuClass === "dedicated" ? 8 : capability.gpuClass === "integrated" ? 4 : 0;
  return upload + cpu + energy + hardware + capability.maximumRenditions;
}

export function evaluateNativePackagerCandidates(candidateValues, request, now = Date.now()) {
  const fields = new Set([
    "selectionVersion", "tenantId", "ownerSubjectRef", "roomId", "programId", "programEpoch",
    "resourceRef", "requestedRenditions", "allowHardwareAcceleration", "requireAcPower",
    "minimumUploadClass", "operatorAllowedAgentIds", "maximumStandbys",
  ]);
  const value = cloneBounded(request, "invalid_broadcast_packager_policy");
  if (!Array.isArray(candidateValues) || candidateValues.length > MAX_CANDIDATES
    || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.selectionVersion !== 1 || !BROADCAST_DOMAIN_PATTERNS.tenantId.test(value.tenantId || "")
    || !SUBJECT.test(value.ownerSubjectRef || "") || !BROADCAST_DOMAIN_PATTERNS.roomId.test(value.roomId || "")
    || !BROADCAST_DOMAIN_PATTERNS.programId.test(value.programId || "")
    || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 1
    || !/^res_[A-Za-z0-9_-]{16,64}$/.test(value.resourceRef || "")
    || !Number.isSafeInteger(value.requestedRenditions) || value.requestedRenditions < 1
    || value.requestedRenditions > 3 || typeof value.allowHardwareAcceleration !== "boolean"
    || typeof value.requireAcPower !== "boolean"
    || !new Set(["under-5mbit", "5-15mbit", "over-15mbit"]).has(value.minimumUploadClass)
    || !Array.isArray(value.operatorAllowedAgentIds) || value.operatorAllowedAgentIds.length > MAX_CANDIDATES
    || new Set(value.operatorAllowedAgentIds).size !== value.operatorAllowedAgentIds.length
    || value.operatorAllowedAgentIds.some((agentId) => !AGENT.test(agentId))
    || !Number.isSafeInteger(value.maximumStandbys) || value.maximumStandbys < 0
    || value.maximumStandbys > MAX_STANDBYS) fail("invalid_broadcast_packager_policy");

  const eligible = [];
  const rejected = [];
  for (const raw of candidateValues) {
    let capability;
    try {
      capability = normalizeNativePackagerCapability(raw, now);
      if (capability.tenantId !== value.tenantId
        || capability.ownerSubjectRef !== value.ownerSubjectRef) {
        throw new NativePackagerPolicyError("native_packager_owner_scope_mismatch", 403);
      }
      if (!value.operatorAllowedAgentIds.includes(capability.agentId)) {
        throw new NativePackagerPolicyError("native_packager_operator_denied", 403);
      }
      if (!capability.consentedRoomIds.includes(value.roomId)) {
        throw new NativePackagerPolicyError("native_packager_room_consent_required", 403);
      }
      if (value.requireAcPower && capability.energyClass !== "ac") {
        throw new NativePackagerPolicyError("native_packager_energy_policy_rejected", 503);
      }
      if (uploadRank(capability.uploadClass) < uploadRank(value.minimumUploadClass)) {
        throw new NativePackagerPolicyError("native_packager_upload_policy_rejected", 503);
      }
      const admission = admitNativePackager(capability, {
        requestVersion: 1,
        trigger: "user-action",
        tenantId: value.tenantId,
        ownerSubjectRef: value.ownerSubjectRef,
        roomId: value.roomId,
        programId: value.programId,
        programEpoch: value.programEpoch,
        resourceRef: value.resourceRef,
        requestedRenditions: value.requestedRenditions,
        allowHardwareAcceleration: value.allowHardwareAcceleration,
      }, now);
      eligible.push(deepFreeze({
        agentId: capability.agentId,
        deviceRef: capability.deviceRef,
        score: candidateScore(capability),
        health: capability.health,
        uploadClass: capability.uploadClass,
        energyClass: capability.energyClass,
        admission,
      }));
    } catch (error) {
      const agentId = typeof raw?.agentId === "string" && AGENT.test(raw.agentId) ? raw.agentId : "invalid";
      rejected.push(deepFreeze({
        agentId,
        reasonCode: error instanceof NativePackagerPolicyError
          ? error.code
          : "invalid_native_packager_capability",
      }));
    }
  }
  eligible.sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));
  rejected.sort((left, right) => left.agentId.localeCompare(right.agentId));
  return deepFreeze({ selectionVersion: 1, maximumStandbys: value.maximumStandbys, eligible, rejected });
}

export function planPackagerWriterSelection(evaluationValue, selection, expectedLeaseEpoch) {
  const evaluation = cloneBounded(evaluationValue, "invalid_broadcast_packager_selection");
  if (evaluation?.selectionVersion !== 1 || !Array.isArray(evaluation.eligible)
    || !Number.isSafeInteger(evaluation.maximumStandbys) || evaluation.maximumStandbys < 0
    || evaluation.maximumStandbys > MAX_STANDBYS
    || !selection || typeof selection !== "object" || Array.isArray(selection)
    || Object.keys(selection).length !== 2
    || !AGENT.test(selection.primaryAgentId || "")
    || !Array.isArray(selection.standbyAgentIds)
    || selection.standbyAgentIds.length > evaluation.maximumStandbys
    || new Set(selection.standbyAgentIds).size !== selection.standbyAgentIds.length
    || selection.standbyAgentIds.some((agentId) => !AGENT.test(agentId))
    || selection.standbyAgentIds.includes(selection.primaryAgentId)) {
    fail("invalid_broadcast_packager_selection");
  }
  positiveInteger(expectedLeaseEpoch, "invalid_broadcast_packager_selection");
  const eligible = new Map(evaluation.eligible.map((candidate) => [candidate.agentId, candidate]));
  const ids = [selection.primaryAgentId, ...selection.standbyAgentIds];
  if (ids.some((agentId) => !eligible.has(agentId))) fail("broadcast_packager_not_eligible", 403);
  return deepFreeze({
    planVersion: 1,
    fencingRevision: expectedLeaseEpoch + 1,
    activeWriter: {
      agentId: selection.primaryAgentId,
      deviceRef: eligible.get(selection.primaryAgentId).deviceRef,
      mayReceiveDecryptKeys: true,
    },
    standbys: selection.standbyAgentIds.map((agentId) => ({
      agentId,
      deviceRef: eligible.get(agentId).deviceRef,
      mayReceiveDecryptKeys: false,
      state: "warm-no-media-key",
    })),
  });
}

export class BroadcastModerationAuditLog {
  #records = [];

  record(actionValue, outcome, errorCode = null, now = Date.now()) {
    if (!actionValue || typeof actionValue !== "object"
      || !ACTION_ROLE_MAP[actionValue.action] || !new Set(["accepted", "denied", "conflict", "failed"]).has(outcome)
      || (errorCode !== null && !/^[a-z][a-z0-9_]{1,63}$/.test(errorCode))) {
      fail("invalid_broadcast_moderation_audit");
    }
    const record = deepFreeze({
      auditVersion: 1,
      actionId: actionValue.actionId,
      action: actionValue.action,
      tenantId: actionValue.tenantId,
      roomId: actionValue.roomId,
      programId: actionValue.programId,
      actorSubjectRef: actionValue.actorSubjectRef,
      expectedProgramRevision: actionValue.expectedProgramRevision,
      expectedProgramEpoch: actionValue.expectedProgramEpoch,
      outcome,
      errorCode,
      occurredAt: now,
    });
    this.#records = [...this.#records.slice(-(MAX_AUDIT_RECORDS - 1)), record];
    return record;
  }

  list() { return deepFreeze([...this.#records]); }
}
