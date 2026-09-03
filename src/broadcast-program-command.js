import crypto from "node:crypto";

import {
  BROADCAST_DOMAIN_PATTERNS,
  BROADCAST_WRITER_ROLES,
  broadcastProgramFail,
  deepFreezeBroadcast,
} from "./broadcast-program-model.js";

const MAX_COMMAND_BYTES = 16 * 1024;
const LIFECYCLE_TRIGGERS = new Set([
  "leave",
  "logout",
  "room-ended",
  "consent-revoked",
  "source-ended",
  "lease-lost",
  "process-abort",
]);
const ADVANCE_TARGETS = new Set(["awaiting_consent", "publishing", "live", "degraded"]);
const COMMAND_FIELDS = Object.freeze({
  create: ["visibility", "title", "viewerPolicyId"],
  start: ["expectedRevision", "expectedBroadcastEpoch", "requiresConsent"],
  advance: ["expectedRevision", "expectedBroadcastEpoch", "toState"],
  "source-change": ["expectedRevision", "expectedBroadcastEpoch", "sourceIds"],
  handoff: ["expectedRevision", "expectedBroadcastEpoch", "expectedLeaseEpoch", "lease"],
  revoke: ["expectedRevision", "expectedBroadcastEpoch", "target", "targetRef", "reasonCode"],
  stop: ["expectedRevision", "expectedBroadcastEpoch", "reasonCode"],
  fail: ["expectedRevision", "expectedBroadcastEpoch", "reasonCode"],
  retry: ["expectedRevision", "expectedBroadcastEpoch", "reasonCode"],
  lifecycle: [
    "expectedRevision",
    "expectedBroadcastEpoch",
    "trigger",
    "role",
    "leaseId",
    "fencingRevision",
    "reasonCode",
  ],
  "cleanup-complete": ["expectedRevision", "expectedBroadcastEpoch", "reasonCode"],
  "visibility-change": [
    "expectedRevision",
    "expectedBroadcastEpoch",
    "visibility",
    "policyHash",
  ],
});
const COMMON_COMMAND_FIELDS = Object.freeze([
  "commandVersion",
  "action",
  "tenantId",
  "actorSubjectRef",
  "roomId",
  "programId",
  "idempotencyKeyHash",
]);

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    broadcastProgramFail("invalid_broadcast_command");
  }
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) broadcastProgramFail("invalid_broadcast_command");
}

function matches(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    broadcastProgramFail("invalid_broadcast_command");
  }
}

function cloneCommand(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    broadcastProgramFail("invalid_broadcast_command");
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_COMMAND_BYTES) {
    broadcastProgramFail("invalid_broadcast_command");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return broadcastProgramFail("invalid_broadcast_command");
  }
}

function normalizeSourceIds(sourceIds) {
  if (!Array.isArray(sourceIds) || sourceIds.length > 20) {
    broadcastProgramFail("invalid_broadcast_source_ids");
  }
  const values = sourceIds.map((value) => {
    matches(value, BROADCAST_DOMAIN_PATTERNS.sourceId);
    return value;
  });
  if (new Set(values).size !== values.length) broadcastProgramFail("invalid_broadcast_source_ids");
  return Object.freeze(values);
}

export function normalizeBroadcastProgramCommand(value) {
  const command = cloneCommand(value);
  assertPlainObject(command);
  if (command.commandVersion !== 1 || !COMMAND_FIELDS[command.action]) {
    broadcastProgramFail("unknown_broadcast_command");
  }
  const allowed = new Set([...COMMON_COMMAND_FIELDS, ...COMMAND_FIELDS[command.action]]);
  if (Object.keys(command).some((field) => !allowed.has(field))) {
    broadcastProgramFail("invalid_broadcast_command");
  }
  if (COMMON_COMMAND_FIELDS.some((field) => command[field] === undefined)) {
    broadcastProgramFail("invalid_broadcast_command");
  }
  matches(command.tenantId, BROADCAST_DOMAIN_PATTERNS.tenantId);
  matches(command.actorSubjectRef, BROADCAST_DOMAIN_PATTERNS.subjectRef);
  matches(command.roomId, BROADCAST_DOMAIN_PATTERNS.roomId);
  matches(command.programId, BROADCAST_DOMAIN_PATTERNS.programId);
  matches(command.idempotencyKeyHash, BROADCAST_DOMAIN_PATTERNS.sha256);
  if (command.action !== "create") {
    positiveInteger(command.expectedRevision);
    positiveInteger(command.expectedBroadcastEpoch);
  }
  if (command.reasonCode !== undefined) matches(command.reasonCode, BROADCAST_DOMAIN_PATTERNS.reasonCode);

  switch (command.action) {
    case "create":
      if (!new Set(["private", "unlisted", "public"]).has(command.visibility)) {
        broadcastProgramFail("invalid_broadcast_command");
      }
      if (command.title !== undefined && (
        typeof command.title !== "string" || command.title.length < 1 || command.title.length > 80
      )) broadcastProgramFail("invalid_broadcast_command");
      if (command.viewerPolicyId !== undefined) {
        matches(command.viewerPolicyId, BROADCAST_DOMAIN_PATTERNS.policyId);
      }
      break;
    case "start":
      if (typeof command.requiresConsent !== "boolean") broadcastProgramFail("invalid_broadcast_command");
      break;
    case "advance":
      if (!ADVANCE_TARGETS.has(command.toState)) broadcastProgramFail("invalid_broadcast_command");
      break;
    case "source-change":
      command.sourceIds = normalizeSourceIds(command.sourceIds);
      break;
    case "handoff":
      positiveInteger(command.expectedLeaseEpoch);
      assertPlainObject(command.lease);
      break;
    case "revoke":
      if (!new Set(["consent", "source"]).has(command.target)) {
        broadcastProgramFail("invalid_broadcast_command");
      }
      matches(
        command.targetRef,
        command.target === "consent"
          ? BROADCAST_DOMAIN_PATTERNS.consentId
          : BROADCAST_DOMAIN_PATTERNS.sourceId,
      );
      if (command.reasonCode === undefined) broadcastProgramFail("invalid_broadcast_command");
      break;
    case "stop":
    case "fail":
    case "retry":
    case "cleanup-complete":
      if (command.reasonCode === undefined) broadcastProgramFail("invalid_broadcast_command");
      break;
    case "visibility-change":
      if (!new Set(["private", "unlisted", "public"]).has(command.visibility)) {
        broadcastProgramFail("invalid_broadcast_command");
      }
      matches(command.policyHash, BROADCAST_DOMAIN_PATTERNS.sha256);
      break;
    case "lifecycle": {
      if (!LIFECYCLE_TRIGGERS.has(command.trigger) || command.reasonCode === undefined) {
        broadcastProgramFail("invalid_broadcast_command");
      }
      const writerTrigger = command.trigger === "lease-lost" || command.trigger === "process-abort";
      if (writerTrigger) {
        if (!BROADCAST_WRITER_ROLES.includes(command.role)) broadcastProgramFail("invalid_broadcast_command");
        matches(command.leaseId, BROADCAST_DOMAIN_PATTERNS.leaseId);
        positiveInteger(command.fencingRevision);
      } else if (command.role !== undefined || command.leaseId !== undefined
        || command.fencingRevision !== undefined) {
        broadcastProgramFail("invalid_broadcast_command");
      }
      break;
    }
    default:
      break;
  }
  return deepFreezeBroadcast(command);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function broadcastProgramCommandHash(command) {
  return crypto.createHash("sha256").update(canonicalJson(command)).digest("hex");
}
