import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import {
  BroadcastAudienceError,
  authorizeBroadcastRoleAction,
  broadcastAudienceFail,
} from "./broadcast-action-policy.js";
import {
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";
import {
  BROADCAST_DOMAIN_PATTERNS,
  deepFreezeBroadcast,
  validateBroadcastProgramMachine,
} from "./broadcast-program-model.js";
import { applyBroadcastProgramCommand } from "./broadcast-program-machine.js";

const VISIBILITIES = new Set(["private", "unlisted", "public"]);
const AUTHENTICATION = new Set(["required", "optional", "none"]);
const SHA256 = /^[a-f0-9]{64}$/;
const CHANGE_FIELDS = new Set([
  "requestVersion",
  "tenantId",
  "roomId",
  "programId",
  "expectedProgramRevision",
  "expectedProgramEpoch",
  "expectedPolicyRevision",
  "visibility",
  "authentication",
  "anonymousAllowed",
  "allowedOriginHashes",
  "idempotencyKeyHash",
]);
const VIEWER_FIELDS = new Set([
  "requestVersion",
  "tenantId",
  "programId",
  "expectedProgramEpoch",
  "expectedPolicyRevision",
  "authenticated",
  "subjectRef",
  "originHash",
]);
const REGISTER_FIELDS = new Set(["machine", "policy", "authorizedViewerSubjectRefs"]);
const ACTIVE_DIRECTORY_STATES = new Set(["live", "degraded"]);
const MAX_AUTHORIZED_VIEWERS = 4096;
const MAX_INPUT_BYTES = 128 * 1024;

function cloneInput(value, code) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    broadcastAudienceFail(code, 400);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
    broadcastAudienceFail(code, 400);
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return broadcastAudienceFail(code, 400);
  }
}

function assertClosed(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.has(field))) {
    broadcastAudienceFail(code, 400);
  }
}

function assertPattern(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) broadcastAudienceFail(code, 400);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) broadcastAudienceFail(code, 400);
  return value;
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    broadcastAudienceFail("invalid_broadcast_audience_time", 400);
  }
  return value;
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

function settingsHash(settings) {
  return crypto.createHash("sha256")
    .update(`broadcast-audience-policy-v1\0${canonicalJson(settings)}`)
    .digest("hex");
}

function normalizeSettings(value) {
  const allowedOriginHashes = value.allowedOriginHashes;
  if (!VISIBILITIES.has(value.visibility) || !AUTHENTICATION.has(value.authentication)
    || typeof value.anonymousAllowed !== "boolean"
    || !Array.isArray(allowedOriginHashes) || allowedOriginHashes.length > 16
    || allowedOriginHashes.some((hash) => !SHA256.test(hash))) {
    broadcastAudienceFail("invalid_broadcast_audience_settings", 400);
  }
  const origins = [...new Set(allowedOriginHashes)].sort();
  if (origins.length !== allowedOriginHashes.length) {
    broadcastAudienceFail("invalid_broadcast_audience_settings", 400);
  }
  if (value.visibility !== "public" && (
    value.authentication !== "required" || value.anonymousAllowed
  )) broadcastAudienceFail("invalid_broadcast_audience_settings", 400);
  if (value.authentication === "required" && value.anonymousAllowed) {
    broadcastAudienceFail("invalid_broadcast_audience_settings", 400);
  }
  if (value.authentication === "none" && !value.anonymousAllowed) {
    broadcastAudienceFail("invalid_broadcast_audience_settings", 400);
  }
  return Object.freeze({
    visibility: value.visibility,
    authentication: value.authentication,
    directoryListed: value.visibility === "public",
    anonymousAllowed: value.anonymousAllowed,
    allowedOriginHashes: Object.freeze(origins),
  });
}

function normalizeChange(value) {
  const request = cloneInput(value, "invalid_broadcast_audience_change");
  assertClosed(request, CHANGE_FIELDS, "invalid_broadcast_audience_change");
  if (Object.keys(request).length !== CHANGE_FIELDS.size || request.requestVersion !== 1) {
    broadcastAudienceFail("invalid_broadcast_audience_change", 400);
  }
  const settings = normalizeSettings(request);
  return Object.freeze({
    requestVersion: 1,
    tenantId: assertPattern(
      request.tenantId,
      BROADCAST_DOMAIN_PATTERNS.tenantId,
      "invalid_broadcast_audience_change",
    ),
    roomId: assertPattern(
      request.roomId,
      BROADCAST_DOMAIN_PATTERNS.roomId,
      "invalid_broadcast_audience_change",
    ),
    programId: assertPattern(
      request.programId,
      BROADCAST_DOMAIN_PATTERNS.programId,
      "invalid_broadcast_audience_change",
    ),
    expectedProgramRevision: positiveInteger(
      request.expectedProgramRevision,
      "invalid_broadcast_audience_change",
    ),
    expectedProgramEpoch: positiveInteger(
      request.expectedProgramEpoch,
      "invalid_broadcast_audience_change",
    ),
    expectedPolicyRevision: positiveInteger(
      request.expectedPolicyRevision,
      "invalid_broadcast_audience_change",
    ),
    idempotencyKeyHash: assertPattern(
      request.idempotencyKeyHash,
      SHA256,
      "invalid_broadcast_audience_change",
    ),
    settings,
    policyHash: settingsHash(settings),
  });
}

function normalizeViewer(value) {
  const request = cloneInput(value, "invalid_broadcast_viewer_request");
  assertClosed(request, VIEWER_FIELDS, "invalid_broadcast_viewer_request");
  const required = [
    "requestVersion", "tenantId", "programId", "expectedProgramEpoch",
    "expectedPolicyRevision", "authenticated",
  ];
  if (required.some((field) => request[field] === undefined) || request.requestVersion !== 1
    || typeof request.authenticated !== "boolean") {
    broadcastAudienceFail("invalid_broadcast_viewer_request", 400);
  }
  if (request.authenticated) {
    assertPattern(
      request.subjectRef,
      BROADCAST_DOMAIN_PATTERNS.subjectRef,
      "invalid_broadcast_viewer_request",
    );
  } else if (request.subjectRef !== undefined) {
    broadcastAudienceFail("invalid_broadcast_viewer_request", 400);
  }
  if (request.originHash !== undefined) {
    assertPattern(request.originHash, SHA256, "invalid_broadcast_viewer_request");
  }
  return Object.freeze({
    requestVersion: 1,
    tenantId: assertPattern(
      request.tenantId,
      BROADCAST_DOMAIN_PATTERNS.tenantId,
      "invalid_broadcast_viewer_request",
    ),
    programId: assertPattern(
      request.programId,
      BROADCAST_DOMAIN_PATTERNS.programId,
      "invalid_broadcast_viewer_request",
    ),
    expectedProgramEpoch: positiveInteger(
      request.expectedProgramEpoch,
      "invalid_broadcast_viewer_request",
    ),
    expectedPolicyRevision: positiveInteger(
      request.expectedPolicyRevision,
      "invalid_broadcast_viewer_request",
    ),
    authenticated: request.authenticated,
    ...(request.subjectRef === undefined ? {} : { subjectRef: request.subjectRef }),
    ...(request.originHash === undefined ? {} : { originHash: request.originHash }),
  });
}

function checkedPolicy(value, program, now) {
  let policy;
  try {
    policy = validateBroadcastContract(value, {
      tenantId: program.tenantId,
      roomId: program.roomId,
      programId: program.programId,
      programEpoch: program.programEpoch,
      requireFresh: false,
    }, now);
  } catch (error) {
    if (error instanceof BroadcastContractError) broadcastAudienceFail(error.code, 400);
    throw error;
  }
  if (policy.type !== "viewer-policy" || policy.ownerSubjectRef !== program.ownerSubjectRef
    || program.viewerPolicyId !== policy.policyId || policy.visibility !== program.visibility) {
    broadcastAudienceFail("broadcast_viewer_policy_mismatch", 409);
  }
  return policy;
}

function normalizeViewerSubjects(values) {
  if (!Array.isArray(values) || values.length > MAX_AUTHORIZED_VIEWERS) {
    broadcastAudienceFail("invalid_broadcast_viewer_subjects", 400);
  }
  const normalized = values.map((value) => assertPattern(
    value,
    BROADCAST_DOMAIN_PATTERNS.subjectRef,
    "invalid_broadcast_viewer_subjects",
  ));
  if (new Set(normalized).size !== normalized.length) {
    broadcastAudienceFail("invalid_broadcast_viewer_subjects", 400);
  }
  return new Set(normalized);
}

function unavailable() {
  broadcastAudienceFail("broadcast_not_available", 404);
}

function recordKey(tenantId, programId) {
  return `${tenantId}\0${programId}`;
}

function snapshot(record, duplicate = false, effects = []) {
  return deepFreezeBroadcast({
    machine: record.machine,
    policy: record.policy,
    duplicate,
    effects,
  });
}

export class BroadcastAudienceRegistry {
  #records = new Map();
  #revokeProgramEpoch;
  #minimumViewerDecisionMs;
  #viewerDecisionDelay;
  #viewerDecisionClock;

  constructor({
    revokeProgramEpoch = () => 0,
    minimumViewerDecisionMs = 20,
    viewerDecisionDelay = delay,
    viewerDecisionClock = () => performance.now(),
  } = {}) {
    if (typeof revokeProgramEpoch !== "function" || typeof viewerDecisionDelay !== "function"
      || typeof viewerDecisionClock !== "function"
      || !Number.isSafeInteger(minimumViewerDecisionMs)
      || minimumViewerDecisionMs < 1 || minimumViewerDecisionMs > 250) {
      broadcastAudienceFail("invalid_broadcast_audience_configuration", 500);
    }
    this.#revokeProgramEpoch = revokeProgramEpoch;
    this.#minimumViewerDecisionMs = minimumViewerDecisionMs;
    this.#viewerDecisionDelay = viewerDecisionDelay;
    this.#viewerDecisionClock = viewerDecisionClock;
  }

  register(value, now = Date.now()) {
    timestamp(now);
    const input = cloneInput(value, "invalid_broadcast_audience_registration");
    assertClosed(input, REGISTER_FIELDS, "invalid_broadcast_audience_registration");
    if (!input.machine || !input.policy) {
      broadcastAudienceFail("invalid_broadcast_audience_registration", 400);
    }
    const machine = validateBroadcastProgramMachine(input.machine);
    if (!machine.program) broadcastAudienceFail("broadcast_program_not_created", 409);
    const policy = checkedPolicy(input.policy, machine.program, now);
    const key = recordKey(machine.scope.tenantId, machine.scope.programId);
    if (this.#records.has(key)) broadcastAudienceFail("broadcast_program_already_registered", 409);
    const record = {
      machine,
      policy,
      viewerSubjectRefs: normalizeViewerSubjects(input.authorizedViewerSubjectRefs || []),
    };
    this.#records.set(key, record);
    return snapshot(record);
  }

  synchronize(value, now = Date.now()) {
    timestamp(now);
    const input = cloneInput(value, "invalid_broadcast_audience_synchronization");
    assertClosed(input, REGISTER_FIELDS, "invalid_broadcast_audience_synchronization");
    if (!input.machine || !input.policy) {
      broadcastAudienceFail("invalid_broadcast_audience_synchronization", 400);
    }
    const machine = validateBroadcastProgramMachine(input.machine);
    if (!machine.program) broadcastAudienceFail("broadcast_program_not_created", 409);
    const key = recordKey(machine.scope.tenantId, machine.scope.programId);
    const current = this.#records.get(key);
    if (!current) broadcastAudienceFail("broadcast_program_not_registered", 404);
    if (machine.scope.ownerSubjectRef !== current.machine.scope.ownerSubjectRef
      || machine.scope.roomId !== current.machine.scope.roomId
      || machine.program.revision < current.machine.program.revision
      || machine.epochs.broadcast < current.machine.epochs.broadcast) {
      broadcastAudienceFail("stale_broadcast_synchronization", 409);
    }
    const policy = checkedPolicy(input.policy, machine.program, now);
    if (policy.revision < current.policy.revision) {
      broadcastAudienceFail("stale_broadcast_policy_revision", 409);
    }
    const record = {
      machine,
      policy,
      viewerSubjectRefs: normalizeViewerSubjects(input.authorizedViewerSubjectRefs || []),
    };
    this.#records.set(key, record);
    return snapshot(record);
  }

  authorizeAction(tenantId, programId, actor, action, context = {}) {
    const record = this.#records.get(recordKey(tenantId, programId));
    if (!record) broadcastAudienceFail("broadcast_program_not_registered", 404);
    return authorizeBroadcastRoleAction(record.machine.program, actor, action, {
      expectedEpoch: record.machine.epochs.membership,
      ...context,
    });
  }

  changeVisibility(value, actorValue, now = Date.now()) {
    timestamp(now);
    const request = normalizeChange(value);
    const key = recordKey(request.tenantId, request.programId);
    const record = this.#records.get(key);
    if (!record || record.machine.scope.roomId !== request.roomId) {
      broadcastAudienceFail("broadcast_program_not_registered", 404);
    }
    const authorization = authorizeBroadcastRoleAction(
      record.machine.program,
      actorValue,
      "program:visibility",
      { expectedEpoch: record.machine.epochs.membership },
    );
    const result = applyBroadcastProgramCommand(record.machine, {
      commandVersion: 1,
      action: "visibility-change",
      tenantId: request.tenantId,
      actorSubjectRef: authorization.actor.subjectRef,
      roomId: request.roomId,
      programId: request.programId,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: request.expectedProgramRevision,
      expectedBroadcastEpoch: request.expectedProgramEpoch,
      visibility: request.settings.visibility,
      policyHash: request.policyHash,
    }, now);
    if (result.duplicate) return snapshot(record, true);
    if (record.policy.revision !== request.expectedPolicyRevision) {
      broadcastAudienceFail("stale_broadcast_policy_revision", 409);
    }
    const program = result.state.program;
    const policy = checkedPolicy({
      ...record.policy,
      revision: record.policy.revision + 1,
      programEpoch: program.programEpoch,
      visibility: request.settings.visibility,
      authentication: request.settings.authentication,
      directoryListed: request.settings.directoryListed,
      anonymousAllowed: request.settings.anonymousAllowed,
      allowedOriginHashes: request.settings.allowedOriginHashes,
      updatedAt: now,
    }, program, now);

    const revokeResult = this.#revokeProgramEpoch(
      program.tenantId,
      program.programId,
      request.expectedProgramEpoch,
      now,
    );
    if (revokeResult && typeof revokeResult.then === "function") {
      broadcastAudienceFail("async_broadcast_epoch_revoker_not_supported", 500);
    }
    if (!Number.isSafeInteger(revokeResult) || revokeResult < 0) {
      broadcastAudienceFail("invalid_broadcast_epoch_revoker_result", 500);
    }
    const nextRecord = {
      machine: result.state,
      policy,
      viewerSubjectRefs: record.viewerSubjectRefs,
    };
    this.#records.set(key, nextRecord);
    return snapshot(nextRecord, false, [
      ...result.effects,
      Object.freeze({
        type: "viewer-policy-changed",
        tenantId: program.tenantId,
        programId: program.programId,
        programRevision: program.revision,
        programEpoch: program.programEpoch,
        policyId: policy.policyId,
        policyRevision: policy.revision,
        visibility: policy.visibility,
      }),
    ]);
  }

  listPublic(tenantId) {
    assertPattern(tenantId, BROADCAST_DOMAIN_PATTERNS.tenantId, "invalid_broadcast_tenant");
    const entries = [...this.#records.values()]
      .filter(({ machine, policy }) => (
        machine.program.tenantId === tenantId
        && machine.program.visibility === "public"
        && policy.visibility === "public"
        && policy.directoryListed === true
        && ACTIVE_DIRECTORY_STATES.has(machine.program.state)
      ))
      .map(({ machine }) => Object.freeze({
        contractVersion: 1,
        type: "broadcast-directory-entry",
        broadcastProgramId: machine.program.programId,
        title: machine.program.title || "Live-Programm",
        broadcastVisibility: "public",
        availability: machine.program.state,
      }))
      .sort((left, right) => (
        left.title.localeCompare(right.title)
        || left.broadcastProgramId.localeCompare(right.broadcastProgramId)
      ));
    return Object.freeze(entries);
  }

  async authorizeViewer(value, now = Date.now()) {
    timestamp(now);
    const request = normalizeViewer(value);
    const startedAt = this.#viewerDecisionClock();
    if (!Number.isFinite(startedAt)) {
      broadcastAudienceFail("invalid_broadcast_audience_clock", 500);
    }
    const record = this.#records.get(recordKey(request.tenantId, request.programId));
    let authorization = null;
    if (record) {
      const { program } = record.machine;
      const { policy } = record;
      const exactVersion = request.expectedProgramEpoch === program.programEpoch
        && request.expectedPolicyRevision === policy.revision;
      const active = ACTIVE_DIRECTORY_STATES.has(program.state);
      const originAllowed = policy.allowedOriginHashes.length === 0
        || (request.originHash && policy.allowedOriginHashes.includes(request.originHash));
      const authenticationAllowed = policy.authentication !== "required"
        ? request.authenticated || policy.anonymousAllowed
        : request.authenticated;
      const entitled = policy.visibility === "public"
        || (request.authenticated && (
          request.subjectRef === program.ownerSubjectRef
          || record.viewerSubjectRefs.has(request.subjectRef)
        ));
      if (exactVersion && active && originAllowed && authenticationAllowed && entitled) {
        authorization = deepFreezeBroadcast({
          authorizationVersion: 1,
          type: "broadcast-playback-only",
          tenantId: program.tenantId,
          roomId: program.roomId,
          programId: program.programId,
          programRevision: program.revision,
          programEpoch: program.programEpoch,
          policyId: policy.policyId,
          policyRevision: policy.revision,
          anonymous: !request.authenticated,
          ...(request.subjectRef === undefined ? {} : { subjectRef: request.subjectRef }),
          actions: ["playback:manifest", "playback:segment"],
          expiresAt: now + 30_000,
        });
      }
    }
    const finishedAt = this.#viewerDecisionClock();
    if (!Number.isFinite(finishedAt)) {
      broadcastAudienceFail("invalid_broadcast_audience_clock", 500);
    }
    const elapsed = Math.max(0, finishedAt - startedAt);
    const remaining = Math.max(0, Math.ceil(this.#minimumViewerDecisionMs - elapsed));
    if (remaining > 0) await this.#viewerDecisionDelay(remaining);
    return authorization || unavailable();
  }
}

export { BroadcastAudienceError };
