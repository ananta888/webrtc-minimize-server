import {
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";
import {
  MAX_BROADCAST_IDEMPOTENCY_RECORDS,
  BROADCAST_WRITER_ROLES,
  broadcastContractContext,
  broadcastProgramFail,
  deepFreezeBroadcast,
  validateBroadcastProgramMachine,
} from "./broadcast-program-model.js";
import {
  broadcastProgramCommandHash,
  normalizeBroadcastProgramCommand,
} from "./broadcast-program-command.js";
import { assertBroadcastTransition } from "./broadcast-transitions.js";

const STOP_TRIGGERS = new Set([
  "leave",
  "logout",
  "room-ended",
  "consent-revoked",
  "source-ended",
]);
const WRITER_ROLES = BROADCAST_WRITER_ROLES;
const fail = broadcastProgramFail;
const deepFreeze = deepFreezeBroadcast;
const contractContext = broadcastContractContext;

export {
  BROADCAST_MACHINE_VERSION,
  MAX_BROADCAST_IDEMPOTENCY_RECORDS,
  BroadcastProgramError,
  initializeBroadcastProgramMachine,
  synchronizeBroadcastRoomEpochs,
  validateBroadcastProgramMachine,
} from "./broadcast-program-model.js";

export function renewBroadcastWriterLeases(stateValue, {
  holderRef, fencingRevision, expiresAt,
}, now = Date.now()) {
  const state = validateBroadcastProgramMachine(stateValue);
  if (!/^pkr_[A-Za-z0-9_-]{16,64}$/.test(holderRef || "")
    || !Number.isSafeInteger(fencingRevision) || fencingRevision < 1
    || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 120_000
    || new Set(["stopping", "stopped", "failed"]).has(state.program?.state)) {
    fail("invalid_broadcast_lease_renewal");
  }
  const packager = activeWriter(state, "packager-writer");
  if (!packager || packager.holderRef !== holderRef
    || packager.fencingRevision !== fencingRevision || packager.expiresAt <= now) {
    fail("stale_broadcast_lease_renewal");
  }
  const writerLeases = state.writerLeases.map((current) => {
    if (current.status !== "active") return current;
    let renewed;
    try {
      renewed = validateBroadcastContract({
        ...current,
        revision: current.revision + 1,
        renewedAt: now,
        expiresAt,
      }, contractContext(state.scope, state.epochs.broadcast, true), now);
    } catch (error) {
      if (error instanceof BroadcastContractError) fail(error.code);
      throw error;
    }
    return renewed;
  });
  return validateBroadcastProgramMachine({ ...state, writerLeases });
}

function assertScope(state, command) {
  for (const field of ["tenantId", "roomId", "programId"]) {
    if (state.scope[field] !== command[field]) fail("broadcast_command_scope_mismatch");
  }
}

function duplicateResult(state, command, fingerprint) {
  const record = state.appliedCommands.find((candidate) => (
    candidate.idempotencyKeyHash === command.idempotencyKeyHash
  ));
  if (!record) return null;
  if (record.commandHash !== fingerprint || record.action !== command.action) {
    fail("broadcast_idempotency_key_reused");
  }
  return deepFreeze({ state, duplicate: true, effects: [] });
}

function assertCurrent(state, command) {
  if (!state.program) fail("broadcast_program_not_created");
  if (command.expectedRevision !== state.program.revision) fail("stale_broadcast_revision");
  if (command.expectedBroadcastEpoch !== state.epochs.broadcast) fail("stale_broadcast_epoch");
}

function recordResult(previousState, nextState, command, fingerprint, effects) {
  if (previousState.appliedCommands.length >= MAX_BROADCAST_IDEMPOTENCY_RECORDS) {
    fail("broadcast_idempotency_capacity_exhausted");
  }
  const appliedRevision = nextState.program?.revision || 1;
  const record = Object.freeze({
    idempotencyKeyHash: command.idempotencyKeyHash,
    commandHash: fingerprint,
    action: command.action,
    appliedRevision,
  });
  const state = validateBroadcastProgramMachine({
    ...nextState,
    appliedCommands: [...previousState.appliedCommands, record],
  });
  return deepFreeze({ state, duplicate: false, effects });
}

function effect(state, type, details = {}) {
  return Object.freeze({
    type,
    tenantId: state.scope.tenantId,
    roomId: state.scope.roomId,
    programId: state.scope.programId,
    programRevision: state.program.revision,
    programEpoch: state.epochs.broadcast,
    leaseEpoch: state.epochs.lease,
    ...details,
  });
}

function updateProgram(state, patch, now) {
  const next = {
    ...state.program,
    ...patch,
    revision: state.program.revision + 1,
    updatedAt: now,
  };
  let program;
  try {
    program = assertBroadcastTransition(
      state.program,
      next,
      contractContext(state.scope, state.epochs.broadcast),
      now,
    );
  } catch (error) {
    if (error instanceof BroadcastContractError) fail(error.code);
    throw error;
  }
  return { ...state, program };
}

function rollProgramEpoch(state, patch, now) {
  const broadcast = state.epochs.broadcast + 1;
  const lease = state.epochs.lease + 1;
  const next = {
    ...state.program,
    ...patch,
    revision: state.program.revision + 1,
    programEpoch: broadcast,
    updatedAt: now,
  };
  let program;
  try {
    program = validateBroadcastContract(next, contractContext(state.scope, broadcast));
  } catch (error) {
    if (error instanceof BroadcastContractError) fail(error.code);
    throw error;
  }
  return {
    ...state,
    epochs: { ...state.epochs, broadcast, lease },
    program,
    writerLeases: [],
  };
}

function activeWriter(state, role) {
  return state.writerLeases.find((lease) => lease.role === role) || null;
}

function assertFreshWriters(state, now) {
  for (const role of WRITER_ROLES) {
    const lease = activeWriter(state, role);
    if (!lease || lease.expiresAt <= now) fail("broadcast_writer_not_ready");
  }
}

function applyCreate(state, command, now) {
  if (state.program) fail("broadcast_program_already_exists");
  if (command.actorSubjectRef !== state.scope.ownerSubjectRef) fail("broadcast_owner_mismatch");
  const program = {
    contractVersion: 1,
    type: "broadcast-program",
    tenantId: state.scope.tenantId,
    ownerSubjectRef: state.scope.ownerSubjectRef,
    roomId: state.scope.roomId,
    programId: state.scope.programId,
    revision: 1,
    programEpoch: state.epochs.broadcast,
    state: "draft",
    visibility: command.visibility,
    ...(command.title === undefined ? {} : { title: command.title }),
    ...(command.viewerPolicyId === undefined ? {} : { viewerPolicyId: command.viewerPolicyId }),
    createdAt: now,
    updatedAt: now,
  };
  try {
    return {
      state: { ...state, program: validateBroadcastContract(program, contractContext(state.scope, state.epochs.broadcast)) },
      effects: [],
    };
  } catch (error) {
    if (error instanceof BroadcastContractError) fail(error.code);
    throw error;
  }
}

function applyStart(state, command, now) {
  if (state.program.state !== "draft") fail("invalid_broadcast_start_state");
  const next = updateProgram(state, { state: "preparing" }, now);
  return {
    state: next,
    effects: [effect(next, "prepare-program", { requiresConsent: command.requiresConsent })],
  };
}

function applyAdvance(state, command, now) {
  if (state.program.state === command.toState) return { state, effects: [] };
  if (command.toState === "publishing" || command.toState === "live") {
    assertFreshWriters(state, now);
  }
  const next = updateProgram(state, { state: command.toState }, now);
  return {
    state: next,
    effects: [effect(next, "program-state-changed", { state: command.toState })],
  };
}

function applySourceChange(state, command, now) {
  if (new Set(["stopping", "stopped", "failed"]).has(state.program.state)) {
    fail("invalid_broadcast_source_change_state");
  }
  if (JSON.stringify(state.program.sourceIds || []) === JSON.stringify(command.sourceIds)) {
    return { state, effects: [] };
  }
  const previousProgramEpoch = state.epochs.broadcast;
  const previousLeaseEpoch = state.epochs.lease;
  const nextState = state.program.state === "draft" ? "draft" : "preparing";
  const next = rollProgramEpoch(state, { state: nextState, sourceIds: command.sourceIds }, now);
  return {
    state: next,
    effects: [
      effect(next, "fence-previous-writers", { previousLeaseEpoch }),
      effect(next, "cleanup-previous-program-epoch", { previousProgramEpoch }),
      effect(next, "prepare-program"),
    ],
  };
}

function applyHandoff(state, command, now) {
  if (new Set(["stopping", "stopped", "failed"]).has(state.program.state)) {
    fail("invalid_broadcast_handoff_state");
  }
  if (command.expectedLeaseEpoch !== state.epochs.lease) fail("stale_broadcast_lease_epoch");
  let lease;
  try {
    lease = validateBroadcastContract(
      command.lease,
      contractContext(state.scope, state.epochs.broadcast, true),
      now,
    );
  } catch (error) {
    if (error instanceof BroadcastContractError) fail(error.code);
    throw error;
  }
  if (lease.type !== "lease" || lease.status !== "active" || !WRITER_ROLES.includes(lease.role)) {
    fail("invalid_broadcast_writer_lease");
  }
  if (lease.fencingRevision !== state.epochs.lease + 1) fail("invalid_broadcast_fencing_revision");
  if (state.writerLeases.some((candidate) => candidate.leaseId === lease.leaseId)) {
    fail("duplicate_broadcast_lease_id");
  }
  const leases = state.writerLeases
    .filter((candidate) => candidate.role !== lease.role)
    .concat(lease)
    .sort((left, right) => left.role.localeCompare(right.role));
  const withLease = {
    ...state,
    epochs: { ...state.epochs, lease: lease.fencingRevision },
    writerLeases: leases,
  };
  const next = updateProgram(withLease, {}, now);
  return {
    state: next,
    effects: [effect(next, "writer-handoff", {
      role: lease.role,
      leaseId: lease.leaseId,
      holderRef: lease.holderRef,
      fencingRevision: lease.fencingRevision,
      expiresAt: lease.expiresAt,
    })],
  };
}

function requestStop(state, reasonCode, now, extraPatch = {}) {
  let next = state;
  if (state.program.state === "draft" || state.program.state === "failed") {
    next = updateProgram(state, { ...extraPatch, state: "stopped" }, now);
  } else if (!new Set(["stopping", "stopped"]).has(state.program.state)) {
    next = updateProgram(state, { ...extraPatch, state: "stopping" }, now);
  } else if (Object.keys(extraPatch).length > 0 && state.program.state !== "stopped") {
    next = updateProgram(state, extraPatch, now);
  }
  if (next === state || state.program.state === "stopped") return { state: next, effects: [] };
  return {
    state: next,
    effects: [
      effect(next, "revoke-program-grants", { reasonCode }),
      effect(next, "stop-delivery", { reasonCode }),
      effect(next, "cleanup-program-sources", { reasonCode }),
    ],
  };
}

function applyRevoke(state, command, now) {
  const currentSourceIds = state.program.sourceIds || [];
  const nextSourceIds = currentSourceIds.filter((sourceId) => sourceId !== command.targetRef);
  const patch = command.target === "source" && nextSourceIds.length !== currentSourceIds.length
    ? { sourceIds: nextSourceIds }
    : {};
  return requestStop(state, command.reasonCode, now, patch);
}

function applyFail(state, command, now) {
  if (state.program.state === "stopped") fail("broadcast_program_terminal");
  if (state.program.state === "draft") fail("invalid_broadcast_failure_state");
  if (state.program.state === "failed") return { state, effects: [] };
  const next = updateProgram(state, { state: "failed" }, now);
  return {
    state: next,
    effects: [
      effect(next, "revoke-program-grants", { reasonCode: command.reasonCode }),
      effect(next, "cleanup-program-sources", { reasonCode: command.reasonCode }),
    ],
  };
}

function applyRetry(state, command, now) {
  if (state.program.state !== "failed") fail("invalid_broadcast_retry_state");
  const previousProgramEpoch = state.epochs.broadcast;
  const previousLeaseEpoch = state.epochs.lease;
  const next = rollProgramEpoch(state, { state: "preparing" }, now);
  return {
    state: next,
    effects: [
      effect(next, "fence-previous-writers", {
        previousLeaseEpoch,
        reasonCode: command.reasonCode,
      }),
      effect(next, "cleanup-previous-program-epoch", {
        previousProgramEpoch,
        reasonCode: command.reasonCode,
      }),
      effect(next, "prepare-program", { reasonCode: command.reasonCode }),
    ],
  };
}

function assertCurrentLease(state, command) {
  const lease = activeWriter(state, command.role);
  if (!lease || lease.leaseId !== command.leaseId
    || lease.fencingRevision !== command.fencingRevision) {
    fail("stale_broadcast_writer_event");
  }
  return lease;
}

function applyWriterLifecycle(state, command, now) {
  const lostLease = assertCurrentLease(state, command);
  if (state.program.state === "stopped") fail("broadcast_program_terminal");
  const remaining = state.writerLeases.filter((lease) => lease.role !== lostLease.role);
  const withoutWriter = {
    ...state,
    epochs: { ...state.epochs, lease: state.epochs.lease + 1 },
    writerLeases: remaining,
  };
  if (command.trigger === "process-abort") {
    if (state.program.state === "draft") fail("invalid_broadcast_failure_state");
    const next = state.program.state === "failed"
      ? withoutWriter
      : updateProgram(withoutWriter, { state: "failed" }, now);
    return {
      state: next,
      effects: [
        effect(next, "fence-writer", { role: lostLease.role, reasonCode: command.reasonCode }),
        effect(next, "revoke-program-grants", { reasonCode: command.reasonCode }),
        effect(next, "cleanup-program-sources", { reasonCode: command.reasonCode }),
      ],
    };
  }

  const degraded = new Set(["publishing", "live"]).has(state.program.state)
    ? updateProgram(withoutWriter, { state: "degraded" }, now)
    : updateProgram(withoutWriter, {}, now);
  const recoverable = !new Set(["stopping", "failed"]).has(state.program.state);
  return {
    state: degraded,
    effects: [
      effect(degraded, "fence-writer", { role: lostLease.role, reasonCode: command.reasonCode }),
      ...(recoverable
        ? [effect(degraded, "request-writer-handoff", {
          role: lostLease.role,
          reasonCode: command.reasonCode,
        })]
        : []),
    ],
  };
}

function applyLifecycle(state, command, now) {
  if (STOP_TRIGGERS.has(command.trigger)) {
    return requestStop(state, command.reasonCode, now);
  }
  return applyWriterLifecycle(state, command, now);
}

function applyCleanupComplete(state, command, now) {
  if (state.program.state === "stopped") return { state, effects: [] };
  if (!new Set(["stopping", "failed"]).has(state.program.state)) {
    fail("invalid_broadcast_cleanup_state");
  }
  const fenced = {
    ...state,
    epochs: { ...state.epochs, lease: state.epochs.lease + 1 },
    writerLeases: [],
  };
  const next = updateProgram(fenced, { state: "stopped" }, now);
  return {
    state: next,
    effects: [effect(next, "cleanup-complete", { reasonCode: command.reasonCode })],
  };
}

function applyVisibilityChange(state, command, now) {
  if (!state.program.viewerPolicyId) fail("broadcast_viewer_policy_required");
  const previousProgramEpoch = state.epochs.broadcast;
  const previousLeaseEpoch = state.epochs.lease;
  const next = rollProgramEpoch(state, { visibility: command.visibility }, now);
  return {
    state: next,
    effects: [
      effect(next, "fence-previous-writers", {
        previousLeaseEpoch,
        reasonCode: "AUDIENCE_POLICY_CHANGED",
      }),
      effect(next, "revoke-program-grants", {
        previousProgramEpoch,
        reasonCode: "AUDIENCE_POLICY_CHANGED",
      }),
      effect(next, "reconfigure-delivery-visibility", {
        visibility: command.visibility,
        policyHash: command.policyHash,
      }),
    ],
  };
}

export function applyBroadcastProgramCommand(value, input, now = Date.now()) {
  const state = validateBroadcastProgramMachine(value);
  const command = normalizeBroadcastProgramCommand(input);
  assertScope(state, command);
  const fingerprint = broadcastProgramCommandHash(command);
  const duplicate = duplicateResult(state, command, fingerprint);
  if (duplicate) return duplicate;
  if (command.action !== "create") assertCurrent(state, command);

  let result;
  switch (command.action) {
    case "create":
      result = applyCreate(state, command, now);
      break;
    case "start":
      result = applyStart(state, command, now);
      break;
    case "advance":
      result = applyAdvance(state, command, now);
      break;
    case "source-change":
      result = applySourceChange(state, command, now);
      break;
    case "handoff":
      result = applyHandoff(state, command, now);
      break;
    case "revoke":
      result = applyRevoke(state, command, now);
      break;
    case "stop":
      result = requestStop(state, command.reasonCode, now);
      break;
    case "fail":
      result = applyFail(state, command, now);
      break;
    case "retry":
      result = applyRetry(state, command, now);
      break;
    case "lifecycle":
      result = applyLifecycle(state, command, now);
      break;
    case "cleanup-complete":
      result = applyCleanupComplete(state, command, now);
      break;
    case "visibility-change":
      result = applyVisibilityChange(state, command, now);
      break;
    default:
      fail("unknown_broadcast_command");
  }
  return recordResult(state, result.state, command, fingerprint, result.effects);
}
