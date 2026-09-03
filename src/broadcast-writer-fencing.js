import {
  BroadcastProgramError,
  validateBroadcastProgramMachine,
} from "./broadcast-program-model.js";

const WRITER_ACTIONS = new Set(["prepare", "publish", "reconfigure", "drain", "stop", "probe"]);
const WRITER_ROLES = new Set(["packager-writer", "gateway-writer"]);
const PRINCIPAL_PATTERN = /^(sub|pkr)_[A-Za-z0-9_-]{16,64}$/;
const LEASE_PATTERN = /^lea_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE_PATTERN = /^res_[A-Za-z0-9_-]{16,64}$/;
const MAX_WRITER_COMMAND_BYTES = 8 * 1024;
const ACTION_STATES = Object.freeze({
  prepare: new Set(["preparing", "awaiting_consent"]),
  publish: new Set(["publishing", "live", "degraded"]),
  reconfigure: new Set(["preparing", "publishing", "live", "degraded"]),
  drain: new Set(["degraded", "stopping", "failed"]),
  stop: new Set(["degraded", "stopping", "failed"]),
  probe: new Set(["preparing", "awaiting_consent", "publishing", "live", "degraded", "stopping", "failed"]),
});

function fail(code) {
  throw new BroadcastProgramError(code);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneCommand(input) {
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    fail("invalid_broadcast_writer_command");
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_WRITER_COMMAND_BYTES) {
    fail("invalid_broadcast_writer_command");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return fail("invalid_broadcast_writer_command");
  }
}

export function authorizeBroadcastWriterCommand(value, input, now = Date.now()) {
  const state = validateBroadcastProgramMachine(value);
  const command = cloneCommand(input);
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    fail("invalid_broadcast_writer_command");
  }
  const allowed = new Set([
    "commandVersion",
    "type",
    "action",
    "tenantId",
    "roomId",
    "programId",
    "programRevision",
    "programEpoch",
    "leaseEpoch",
    "role",
    "leaseId",
    "holderRef",
    "fencingRevision",
    "operationRef",
  ]);
  if (Object.keys(command).some((field) => !allowed.has(field))) fail("invalid_broadcast_writer_command");
  if (command.commandVersion !== 1 || command.type !== "broadcast-writer-command"
    || !WRITER_ACTIONS.has(command.action) || !WRITER_ROLES.has(command.role)
    || !LEASE_PATTERN.test(command.leaseId || "") || !PRINCIPAL_PATTERN.test(command.holderRef || "")
    || !positiveInteger(command.programRevision) || !positiveInteger(command.programEpoch)
    || !positiveInteger(command.leaseEpoch) || !positiveInteger(command.fencingRevision)
    || (command.operationRef !== undefined && !RESOURCE_PATTERN.test(command.operationRef))) {
    fail("invalid_broadcast_writer_command");
  }
  if (!state.program) fail("broadcast_program_not_created");
  for (const field of ["tenantId", "roomId", "programId"]) {
    if (command[field] !== state.scope[field]) fail("broadcast_writer_scope_mismatch");
  }
  if (command.programRevision !== state.program.revision) fail("stale_broadcast_revision");
  if (command.programEpoch !== state.epochs.broadcast) fail("stale_broadcast_epoch");
  if (command.leaseEpoch !== state.epochs.lease) fail("stale_broadcast_lease_epoch");
  if (state.program.state === "stopped") fail("broadcast_program_terminal");
  if (!ACTION_STATES[command.action].has(state.program.state)) {
    fail("invalid_broadcast_writer_action_state");
  }

  const lease = state.writerLeases.find((candidate) => candidate.role === command.role);
  if (!lease || lease.status !== "active" || lease.leaseId !== command.leaseId
    || lease.holderRef !== command.holderRef || lease.fencingRevision !== command.fencingRevision) {
    fail("invalid_broadcast_writer_fence");
  }
  if (lease.expiresAt <= now) fail("expired_broadcast_writer_fence");

  return deepFreeze(command);
}
