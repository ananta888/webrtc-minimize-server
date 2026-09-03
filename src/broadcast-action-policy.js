import {
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";
import { BROADCAST_DOMAIN_PATTERNS } from "./broadcast-program-model.js";

export const BROADCAST_ROLES = Object.freeze([
  "owner",
  "moderator",
  "presenter",
  "packager",
  "viewer",
]);

export const BROADCAST_ACTIONS = Object.freeze([
  "program:start",
  "program:stop",
  "program:visibility",
  "source:publish",
  "source:revoke",
  "packager:operate",
  "packager:handoff",
  "viewer:allow",
  "viewer:deny",
  "playback:view",
]);

const ROLE_ACTIONS = Object.freeze({
  owner: new Set(BROADCAST_ACTIONS),
  moderator: new Set([
    "program:start",
    "program:stop",
    "program:visibility",
    "source:publish",
    "source:revoke",
    "packager:handoff",
    "viewer:allow",
    "viewer:deny",
    "playback:view",
  ]),
  presenter: new Set(["source:publish", "source:revoke", "playback:view"]),
  packager: new Set(["packager:operate", "playback:view"]),
  viewer: new Set(["playback:view"]),
});

const ACTOR_FIELDS = new Set([
  "projectionVersion",
  "source",
  "active",
  "tenantId",
  "roomId",
  "subjectRef",
  "role",
  "epoch",
]);

export class BroadcastAudienceError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = "BroadcastAudienceError";
    this.code = code;
    this.status = status;
  }
}

export function broadcastAudienceFail(code, status) {
  throw new BroadcastAudienceError(code, status);
}

function positiveInteger(value, code = "invalid_broadcast_actor") {
  if (!Number.isSafeInteger(value) || value < 1) broadcastAudienceFail(code, 400);
  return value;
}

function assertPattern(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) broadcastAudienceFail(code, 400);
  return value;
}

export function normalizeBroadcastServerActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !ACTOR_FIELDS.has(field))
    || Object.keys(value).length !== ACTOR_FIELDS.size
    || value.projectionVersion !== 1 || value.active !== true
    || !BROADCAST_ROLES.includes(value.role)) {
    broadcastAudienceFail("invalid_broadcast_actor", 400);
  }
  const expectedSource = value.role === "viewer" ? "broadcast-audience" : "room-membership";
  if (value.source !== expectedSource) broadcastAudienceFail("invalid_broadcast_actor", 400);
  return Object.freeze({
    projectionVersion: 1,
    source: value.source,
    active: true,
    tenantId: assertPattern(
      value.tenantId,
      BROADCAST_DOMAIN_PATTERNS.tenantId,
      "invalid_broadcast_actor",
    ),
    roomId: assertPattern(
      value.roomId,
      BROADCAST_DOMAIN_PATTERNS.roomId,
      "invalid_broadcast_actor",
    ),
    subjectRef: assertPattern(
      value.subjectRef,
      BROADCAST_DOMAIN_PATTERNS.subjectRef,
      "invalid_broadcast_actor",
    ),
    role: value.role,
    epoch: positiveInteger(value.epoch),
  });
}

function checkedProgram(value) {
  try {
    const program = validateBroadcastContract(value, { requireFresh: false });
    if (program.type !== "broadcast-program") broadcastAudienceFail("invalid_broadcast_program", 400);
    return program;
  } catch (error) {
    if (error instanceof BroadcastContractError) {
      broadcastAudienceFail(error.code, 400);
    }
    throw error;
  }
}

export function authorizeBroadcastRoleAction(value, actorValue, action, context = {}) {
  const program = checkedProgram(value);
  const actor = normalizeBroadcastServerActor(actorValue);
  if (!BROADCAST_ACTIONS.includes(action)) broadcastAudienceFail("unknown_broadcast_action", 400);
  if (!context || typeof context !== "object" || Array.isArray(context)
    || Object.keys(context).some((field) => !new Set([
      "expectedEpoch", "targetSubjectRef",
    ]).has(field))) {
    broadcastAudienceFail("invalid_broadcast_action_context", 400);
  }
  positiveInteger(context.expectedEpoch, "invalid_broadcast_action_context");
  if (actor.tenantId !== program.tenantId || actor.roomId !== program.roomId
    || actor.epoch !== context.expectedEpoch) {
    broadcastAudienceFail("broadcast_actor_scope_mismatch");
  }
  if (actor.role === "owner" && actor.subjectRef !== program.ownerSubjectRef) {
    broadcastAudienceFail("broadcast_action_denied");
  }
  if (!ROLE_ACTIONS[actor.role].has(action)) broadcastAudienceFail("broadcast_action_denied");
  if (actor.role === "presenter" && new Set(["source:publish", "source:revoke"]).has(action)) {
    if (context.targetSubjectRef !== actor.subjectRef) {
      broadcastAudienceFail("broadcast_action_denied");
    }
  } else if (context.targetSubjectRef !== undefined) {
    assertPattern(
      context.targetSubjectRef,
      BROADCAST_DOMAIN_PATTERNS.subjectRef,
      "invalid_broadcast_action_context",
    );
  }
  return Object.freeze({ actor, action });
}
