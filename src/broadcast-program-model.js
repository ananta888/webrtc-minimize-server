import {
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";

export const BROADCAST_MACHINE_VERSION = 1;
export const MAX_BROADCAST_IDEMPOTENCY_RECORDS = 256;
export const BROADCAST_PROGRAM_ACTIONS = Object.freeze([
  "create",
  "start",
  "advance",
  "source-change",
  "handoff",
  "revoke",
  "stop",
  "fail",
  "retry",
  "lifecycle",
  "cleanup-complete",
]);
export const BROADCAST_WRITER_ROLES = Object.freeze(["packager-writer", "gateway-writer"]);
export const BROADCAST_DOMAIN_PATTERNS = Object.freeze({
  tenantId: /^tn_[A-Za-z0-9_-]{16,64}$/,
  subjectRef: /^sub_[A-Za-z0-9_-]{16,64}$/,
  roomId: /^[a-z0-9][a-z0-9-]{5,47}$/,
  programId: /^prg_[A-Za-z0-9_-]{16,64}$/,
  sourceId: /^src_[A-Za-z0-9_-]{16,64}$/,
  consentId: /^cns_[A-Za-z0-9_-]{16,64}$/,
  leaseId: /^lea_[A-Za-z0-9_-]{16,64}$/,
  sha256: /^[a-f0-9]{64}$/,
  reasonCode: /^[A-Z][A-Z0-9_]{1,31}$/,
});

const MAX_MACHINE_BYTES = 256 * 1024;
const SAFE_EPOCH_FIELDS = Object.freeze([
  "membership",
  "route",
  "topology",
  "broadcast",
  "lease",
]);
const ROOM_EPOCH_FIELDS = new Set(["membership", "route", "topology"]);

export class BroadcastProgramError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastProgramError";
    this.code = code;
  }
}

export function broadcastProgramFail(code) {
  throw new BroadcastProgramError(code);
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) broadcastProgramFail(code);
}

function assertClosed(value, allowedFields, code) {
  assertPlainObject(value, code);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) broadcastProgramFail(code);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) broadcastProgramFail(code);
  return value;
}

function matches(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) broadcastProgramFail(code);
  return value;
}

function cloneMachine(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    broadcastProgramFail("invalid_broadcast_machine");
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_MACHINE_BYTES) {
    broadcastProgramFail("invalid_broadcast_machine");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return broadcastProgramFail("invalid_broadcast_machine");
  }
}

export function deepFreezeBroadcast(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeBroadcast(child);
  return Object.freeze(value);
}

function normalizeScope(scope) {
  assertClosed(scope, new Set(["tenantId", "ownerSubjectRef", "roomId", "programId"]), "invalid_broadcast_scope");
  return Object.freeze({
    tenantId: matches(scope.tenantId, BROADCAST_DOMAIN_PATTERNS.tenantId, "invalid_broadcast_scope"),
    ownerSubjectRef: matches(
      scope.ownerSubjectRef,
      BROADCAST_DOMAIN_PATTERNS.subjectRef,
      "invalid_broadcast_scope",
    ),
    roomId: matches(scope.roomId, BROADCAST_DOMAIN_PATTERNS.roomId, "invalid_broadcast_scope"),
    programId: matches(scope.programId, BROADCAST_DOMAIN_PATTERNS.programId, "invalid_broadcast_scope"),
  });
}

function normalizeEpochs(epochs) {
  assertClosed(epochs, new Set(SAFE_EPOCH_FIELDS), "invalid_broadcast_epochs");
  if (SAFE_EPOCH_FIELDS.some((field) => epochs[field] === undefined)) {
    broadcastProgramFail("invalid_broadcast_epochs");
  }
  return Object.freeze(Object.fromEntries(SAFE_EPOCH_FIELDS.map((field) => [
    field,
    positiveInteger(epochs[field], "invalid_broadcast_epochs"),
  ])));
}

function normalizeIdempotencyRecord(record) {
  assertClosed(
    record,
    new Set(["idempotencyKeyHash", "commandHash", "action", "appliedRevision"]),
    "invalid_broadcast_idempotency_record",
  );
  if (!BROADCAST_PROGRAM_ACTIONS.includes(record.action)) {
    broadcastProgramFail("invalid_broadcast_idempotency_record");
  }
  return Object.freeze({
    idempotencyKeyHash: matches(
      record.idempotencyKeyHash,
      BROADCAST_DOMAIN_PATTERNS.sha256,
      "invalid_broadcast_idempotency_record",
    ),
    commandHash: matches(
      record.commandHash,
      BROADCAST_DOMAIN_PATTERNS.sha256,
      "invalid_broadcast_idempotency_record",
    ),
    action: record.action,
    appliedRevision: positiveInteger(record.appliedRevision, "invalid_broadcast_idempotency_record"),
  });
}

export function broadcastContractContext(scope, programEpoch, requireFresh = false) {
  return {
    tenantId: scope.tenantId,
    roomId: scope.roomId,
    programId: scope.programId,
    ...(programEpoch === undefined ? {} : { programEpoch }),
    requireFresh,
  };
}

function checkedContract(value, context) {
  try {
    return validateBroadcastContract(value, context);
  } catch (error) {
    if (error instanceof BroadcastContractError) broadcastProgramFail(error.code);
    throw error;
  }
}

export function validateBroadcastProgramMachine(value) {
  const state = cloneMachine(value);
  assertClosed(
    state,
    new Set(["machineVersion", "scope", "epochs", "program", "writerLeases", "appliedCommands"]),
    "invalid_broadcast_machine",
  );
  if (state.machineVersion !== BROADCAST_MACHINE_VERSION) {
    broadcastProgramFail("unsupported_broadcast_machine_version");
  }
  const scope = normalizeScope(state.scope);
  const epochs = normalizeEpochs(state.epochs);
  if (!Array.isArray(state.writerLeases) || state.writerLeases.length > BROADCAST_WRITER_ROLES.length) {
    broadcastProgramFail("invalid_broadcast_writer_leases");
  }
  if (!Array.isArray(state.appliedCommands)
    || state.appliedCommands.length > MAX_BROADCAST_IDEMPOTENCY_RECORDS) {
    broadcastProgramFail("invalid_broadcast_idempotency_ledger");
  }
  const appliedCommands = state.appliedCommands.map(normalizeIdempotencyRecord);
  if (new Set(appliedCommands.map((record) => record.idempotencyKeyHash)).size !== appliedCommands.length) {
    broadcastProgramFail("invalid_broadcast_idempotency_ledger");
  }

  const program = state.program === null
    ? null
    : checkedContract(state.program, broadcastContractContext(scope, epochs.broadcast));
  if (program && program.ownerSubjectRef !== scope.ownerSubjectRef) {
    broadcastProgramFail("broadcast_owner_mismatch");
  }
  if (program && program.programEpoch !== epochs.broadcast) broadcastProgramFail("broadcast_epoch_mismatch");
  if (!program && (state.writerLeases.length > 0 || appliedCommands.length > 0)) {
    broadcastProgramFail("broadcast_state_without_program");
  }
  if (program && appliedCommands.some((record) => record.appliedRevision > program.revision)) {
    broadcastProgramFail("invalid_broadcast_idempotency_ledger");
  }

  const writerLeases = state.writerLeases.map((lease) => {
    if (!program) broadcastProgramFail("broadcast_lease_without_program");
    const validated = checkedContract(
      lease,
      broadcastContractContext(scope, epochs.broadcast),
    );
    if (validated.type !== "lease" || validated.status !== "active"
      || validated.fencingRevision > epochs.lease) {
      broadcastProgramFail("invalid_broadcast_writer_lease");
    }
    return validated;
  }).sort((left, right) => left.role.localeCompare(right.role));
  if (new Set(writerLeases.map((lease) => lease.role)).size !== writerLeases.length) {
    broadcastProgramFail("duplicate_active_broadcast_writer");
  }
  if (new Set(writerLeases.map((lease) => lease.leaseId)).size !== writerLeases.length) {
    broadcastProgramFail("duplicate_broadcast_lease_id");
  }

  return deepFreezeBroadcast({
    machineVersion: BROADCAST_MACHINE_VERSION,
    scope,
    epochs,
    program,
    writerLeases,
    appliedCommands,
  });
}

export function initializeBroadcastProgramMachine(scope, epochs) {
  return validateBroadcastProgramMachine({
    machineVersion: BROADCAST_MACHINE_VERSION,
    scope,
    epochs,
    program: null,
    writerLeases: [],
    appliedCommands: [],
  });
}

export function synchronizeBroadcastRoomEpochs(value, updates) {
  const state = validateBroadcastProgramMachine(value);
  assertPlainObject(updates, "invalid_broadcast_room_epochs");
  const keys = Object.keys(updates);
  if (keys.length < 1 || keys.some((field) => !ROOM_EPOCH_FIELDS.has(field))) {
    broadcastProgramFail("invalid_broadcast_room_epochs");
  }
  const epochs = { ...state.epochs };
  for (const field of keys) {
    const next = positiveInteger(updates[field], "invalid_broadcast_room_epochs");
    if (next < epochs[field]) broadcastProgramFail("stale_broadcast_room_epoch");
    epochs[field] = next;
  }
  return deepFreezeBroadcast({ ...state, epochs });
}
