import crypto from "node:crypto";

import { BROADCAST_DOMAIN_PATTERNS } from "./broadcast-program-model.js";

const ROLES = new Set(["packager-writer", "gateway-writer"]);
const HEALTH = new Set(["healthy", "degraded", "unavailable"]);
const CONSENT = new Set(["none", "approved", "preauthorized"]);
const FAILURE_TYPES = new Set(["packager", "browser", "gateway", "host", "network", "provider"]);
const EVENT_TYPES = new Set([
  "standbys-configured", "writer-acquired", "writer-fenced", "writer-takeover", "program-stopped",
]);
const MAX_CANDIDATES = 8;
const MAX_OUTBOX = 256;
const SAFE_REF = /^(sub|pkr)_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_REF = /^dev_[A-Za-z0-9_-]{16,64}$/;

export class BroadcastFailoverError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastFailoverError";
    this.code = code;
  }
}

function fail(code) {
  throw new BroadcastFailoverError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function closed(value, fields, code) {
  plain(value, code);
  if (Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function matches(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function clone(value, code = "invalid_broadcast_failover_input") {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    fail(code);
  }
  if (json === undefined || Buffer.byteLength(json) > 256 * 1024) fail(code);
  try {
    return JSON.parse(json);
  } catch {
    return fail(code);
  }
}

function scopeKey(scope) {
  return `${scope.tenantId}:${scope.programId}`;
}

function normalizeScope(value) {
  closed(value, new Set(["tenantId", "roomId", "programId", "programEpoch", "leaseEpoch"]), "invalid_broadcast_failover_scope");
  return freeze({
    tenantId: matches(value.tenantId, BROADCAST_DOMAIN_PATTERNS.tenantId, "invalid_broadcast_failover_scope"),
    roomId: matches(value.roomId, BROADCAST_DOMAIN_PATTERNS.roomId, "invalid_broadcast_failover_scope"),
    programId: matches(value.programId, BROADCAST_DOMAIN_PATTERNS.programId, "invalid_broadcast_failover_scope"),
    programEpoch: integer(value.programEpoch, 1, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_scope"),
    leaseEpoch: integer(value.leaseEpoch, 1, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_scope"),
  });
}

function normalizeCandidate(value, now) {
  closed(value, new Set([
    "holderRef", "deviceRef", "priority", "volunteerConsent", "decryptConsent",
    "consentExpiresAt", "health", "quorumEligible",
  ]), "invalid_broadcast_failover_candidate");
  if (value.volunteerConsent !== true || !CONSENT.has(value.decryptConsent)
    || !HEALTH.has(value.health) || typeof value.quorumEligible !== "boolean") {
    fail("invalid_broadcast_failover_candidate");
  }
  const candidate = {
    holderRef: matches(value.holderRef, SAFE_REF, "invalid_broadcast_failover_candidate"),
    deviceRef: matches(value.deviceRef, DEVICE_REF, "invalid_broadcast_failover_candidate"),
    priority: integer(value.priority, 0, 1_000, "invalid_broadcast_failover_candidate"),
    volunteerConsent: true,
    decryptConsent: value.decryptConsent,
    consentExpiresAt: integer(value.consentExpiresAt, 0, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_candidate"),
    health: value.health,
    quorumEligible: value.quorumEligible,
    access: "none",
  };
  if (candidate.decryptConsent !== "none" && candidate.consentExpiresAt <= now) {
    candidate.decryptConsent = "none";
  }
  return candidate;
}

function normalizeSignals(value) {
  closed(value, new Set(["writer", "browserSource", "gateway", "host", "network", "provider"]), "invalid_broadcast_failover_signals");
  const result = {};
  for (const field of ["writer", "browserSource", "gateway", "host", "network", "provider"]) {
    if (!HEALTH.has(value[field])) fail("invalid_broadcast_failover_signals");
    result[field] = value[field];
  }
  return freeze(result);
}

function nullableInteger(value, code) {
  if (value === null) return null;
  return integer(value, 0, Number.MAX_SAFE_INTEGER, code);
}

function normalizeActive(value) {
  if (value === null) return null;
  closed(value, new Set([
    "leaseId", "holderRef", "deviceRef", "fencingRevision", "issuedAt", "lastHeartbeatAt",
    "expiresAt", "access",
  ]), "invalid_broadcast_failover_snapshot");
  const active = {
    leaseId: matches(value.leaseId, BROADCAST_DOMAIN_PATTERNS.leaseId, "invalid_broadcast_failover_snapshot"),
    holderRef: matches(value.holderRef, SAFE_REF, "invalid_broadcast_failover_snapshot"),
    deviceRef: matches(value.deviceRef, DEVICE_REF, "invalid_broadcast_failover_snapshot"),
    fencingRevision: integer(value.fencingRevision, 1, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot"),
    issuedAt: integer(value.issuedAt, 0, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot"),
    lastHeartbeatAt: integer(value.lastHeartbeatAt, 0, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot"),
    expiresAt: integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot"),
    access: value.access,
  };
  if (!new Set(["source-and-decrypt", "gateway-writer"]).has(active.access)
    || active.lastHeartbeatAt < active.issuedAt || active.expiresAt <= active.lastHeartbeatAt) {
    fail("invalid_broadcast_failover_snapshot");
  }
  return active;
}

function normalizeOutboxEvent(value, scope) {
  closed(value, new Set([
    "eventVersion", "eventId", "type", "tenantId", "roomId", "programId", "programEpoch",
    "role", "occurredAt", "standbyCount", "failureType", "fencingRevision", "disposition",
    "reasonCode",
  ]), "invalid_broadcast_failover_snapshot");
  if (value.eventVersion !== 1 || !EVENT_TYPES.has(value.type) || !ROLES.has(value.role)
    || value.tenantId !== scope.tenantId || value.roomId !== scope.roomId
    || value.programId !== scope.programId || value.programEpoch !== scope.programEpoch) {
    fail("invalid_broadcast_failover_snapshot");
  }
  matches(value.eventId, BROADCAST_DOMAIN_PATTERNS.sha256, "invalid_broadcast_failover_snapshot");
  integer(value.occurredAt, 0, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot");
  if (value.failureType !== undefined && value.failureType !== null && !FAILURE_TYPES.has(value.failureType)) {
    fail("invalid_broadcast_failover_snapshot");
  }
  if (value.fencingRevision !== undefined) {
    integer(value.fencingRevision, 1, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot");
  }
  if (value.standbyCount !== undefined) integer(value.standbyCount, 0, 4, "invalid_broadcast_failover_snapshot");
  if (value.disposition !== undefined && !new Set(["resume", "visible-stop"]).has(value.disposition)) {
    fail("invalid_broadcast_failover_snapshot");
  }
  if (value.reasonCode !== undefined) {
    matches(value.reasonCode, BROADCAST_DOMAIN_PATTERNS.reasonCode, "invalid_broadcast_failover_snapshot");
  }
  return value;
}

export function classifyBroadcastFailure(input) {
  const signals = normalizeSignals(clone(input));
  if (signals.browserSource === "unavailable") return "browser";
  if (signals.host === "unavailable") return "host";
  if (signals.network === "unavailable") return "network";
  if (signals.provider === "unavailable") return "provider";
  if (signals.gateway === "unavailable") return "gateway";
  return "packager";
}

function quorumHealthy(input) {
  closed(input, new Set(["healthyVotes", "totalVotes"]), "invalid_broadcast_failover_quorum");
  const total = integer(input.totalVotes, 1, 31, "invalid_broadcast_failover_quorum");
  const healthy = integer(input.healthyVotes, 0, total, "invalid_broadcast_failover_quorum");
  return healthy >= Math.floor(total / 2) + 1;
}

function deterministicCandidates(candidates, now, excludeRef) {
  return candidates
    .filter((candidate) => candidate.holderRef !== excludeRef
      && candidate.health === "healthy"
      && candidate.quorumEligible
      && candidate.decryptConsent !== "none"
      && candidate.consentExpiresAt > now)
    .sort((left, right) => right.priority - left.priority
      || left.holderRef.localeCompare(right.holderRef)
      || left.deviceRef.localeCompare(right.deviceRef));
}

function leaseId(scope, role, fencingRevision, holderRef) {
  const digest = crypto.createHash("sha256")
    .update(`${scope.tenantId}:${scope.programId}:${scope.programEpoch}:${role}:${fencingRevision}:${holderRef}`)
    .digest("base64url").slice(0, 24);
  return `lea_${digest}`;
}

function eventId(scope, sequence, type) {
  return crypto.createHash("sha256")
    .update(`${scope.tenantId}:${scope.programId}:${scope.programEpoch}:${sequence}:${type}`)
    .digest("hex");
}

function recoveryFor(failureType, tookOver) {
  if (!tookOver || failureType === "browser") {
    return freeze({ disposition: "visible-stop", discontinuity: false, playerRestart: false });
  }
  return freeze({ disposition: "resume", discontinuity: true, playerRestart: true });
}

export class BroadcastFailoverCoordinator {
  #programs = new Map();
  #leaseTtlMs;
  #graceMs;
  #recoveryDeadlineMs;
  #maxStandbys;

  constructor({ leaseTtlMs = 15_000, graceMs = 5_000, recoveryDeadlineMs = 30_000, maxStandbys = 2 } = {}) {
    this.#leaseTtlMs = integer(leaseTtlMs, 5_000, 120_000, "invalid_broadcast_failover_config");
    this.#graceMs = integer(graceMs, 0, this.#leaseTtlMs, "invalid_broadcast_failover_config");
    this.#recoveryDeadlineMs = integer(recoveryDeadlineMs, this.#graceMs + 1, 300_000, "invalid_broadcast_failover_config");
    this.#maxStandbys = integer(maxStandbys, 1, 4, "invalid_broadcast_failover_config");
  }

  register(input) {
    const scope = normalizeScope(clone(input));
    const key = scopeKey(scope);
    const existing = this.#programs.get(key);
    if (existing) {
      if (existing.scope.roomId !== scope.roomId || existing.scope.programEpoch !== scope.programEpoch) {
        fail("broadcast_failover_scope_conflict");
      }
      return this.snapshot(scope);
    }
    this.#programs.set(key, {
      scope: { ...scope },
      fencingRevision: scope.leaseEpoch,
      roles: new Map([...ROLES].map((role) => [role, {
        candidates: [], active: null, failureSince: null, lastFailureType: null,
      }])),
      outbox: [],
      sequence: 0,
      stopped: false,
    });
    return this.snapshot(scope);
  }

  configureCandidates(scopeInput, role, candidatesInput, now = Date.now()) {
    const program = this.#get(scopeInput);
    this.#role(role);
    if (!Array.isArray(candidatesInput) || candidatesInput.length > MAX_CANDIDATES) {
      fail("invalid_broadcast_failover_candidates");
    }
    const candidates = candidatesInput.map((candidate) => normalizeCandidate(clone(candidate), now));
    const identities = candidates.map((candidate) => `${candidate.holderRef}:${candidate.deviceRef}`);
    if (new Set(identities).size !== identities.length) fail("duplicate_broadcast_failover_candidate");
    const current = program.roles.get(role);
    current.candidates = candidates.sort((left, right) => right.priority - left.priority
      || left.holderRef.localeCompare(right.holderRef));
    this.#emit(program, "standbys-configured", role, now, {
      standbyCount: Math.min(current.candidates.length, this.#maxStandbys),
    });
    return this.roleSnapshot(scopeInput, role, now);
  }

  acquire(scopeInput, role, now = Date.now()) {
    const program = this.#get(scopeInput);
    this.#role(role);
    if (program.stopped) fail("broadcast_failover_program_stopped");
    const state = program.roles.get(role);
    if (state.active && state.active.expiresAt > now) fail("broadcast_failover_writer_exists");
    const [candidate] = deterministicCandidates(state.candidates, now, state.active?.holderRef);
    if (!candidate) return this.#stop(
      program,
      role,
      role === "packager-writer" ? "packager" : "gateway",
      now,
      "NO_AUTHORIZED_STANDBY",
    );
    return this.#promote(program, role, candidate, now, null);
  }

  heartbeat(scopeInput, role, input, now = Date.now()) {
    const program = this.#get(scopeInput);
    this.#role(role);
    const heartbeat = clone(input);
    closed(heartbeat, new Set(["leaseId", "holderRef", "fencingRevision", "health", "quorum"]), "invalid_broadcast_failover_heartbeat");
    const state = program.roles.get(role);
    const active = state.active;
    if (!active || heartbeat.leaseId !== active.leaseId || heartbeat.holderRef !== active.holderRef
      || heartbeat.fencingRevision !== active.fencingRevision) fail("stale_broadcast_failover_heartbeat");
    if (!HEALTH.has(heartbeat.health)) fail("invalid_broadcast_failover_heartbeat");
    const healthy = heartbeat.health === "healthy" && quorumHealthy(heartbeat.quorum);
    if (!healthy) {
      state.failureSince ??= now;
      return freeze({ accepted: false, graceUntil: state.failureSince + this.#graceMs });
    }
    active.lastHeartbeatAt = now;
    active.expiresAt = now + this.#leaseTtlMs;
    state.failureSince = null;
    return freeze({ accepted: true, expiresAt: active.expiresAt });
  }

  evaluate(scopeInput, role, input, now = Date.now()) {
    const program = this.#get(scopeInput);
    this.#role(role);
    const signals = normalizeSignals(clone(input));
    const state = program.roles.get(role);
    const active = state.active;
    const signalHealthy = Object.values(signals).every((health) => health !== "unavailable");
    if (active && active.expiresAt > now && signalHealthy && state.failureSince === null) {
      return freeze({ action: "none", active: { ...active } });
    }
    const failureType = signals.writer === "unavailable" || signalHealthy
      ? (role === "packager-writer" ? "packager" : "gateway")
      : classifyBroadcastFailure(signals);
    if (!FAILURE_TYPES.has(failureType)) fail("invalid_broadcast_failure_type");
    state.failureSince ??= Math.min(now, active?.expiresAt || now);
    state.lastFailureType = failureType;
    const graceUntil = state.failureSince + this.#graceMs;
    if (now < graceUntil) return freeze({ action: "grace", failureType, graceUntil });

    if (active) {
      this.#emit(program, "writer-fenced", role, now, {
        failureType,
        fencingRevision: active.fencingRevision,
      });
      state.active = null;
    }
    if (failureType === "browser" || now > state.failureSince + this.#recoveryDeadlineMs) {
      return this.#stop(program, role, failureType, now, "RECOVERY_NOT_SAFE");
    }
    const [candidate] = deterministicCandidates(state.candidates, now, active?.holderRef);
    if (!candidate) return this.#stop(program, role, failureType, now, "NO_AUTHORIZED_STANDBY");
    return this.#promote(program, role, candidate, now, failureType);
  }

  authorizeWriter(scopeInput, role, leaseInput, now = Date.now()) {
    const program = this.#get(scopeInput);
    this.#role(role);
    const active = program.roles.get(role).active;
    const lease = clone(leaseInput);
    closed(lease, new Set(["leaseId", "holderRef", "fencingRevision"]), "invalid_broadcast_failover_fence");
    if (program.stopped || !active || active.expiresAt <= now || lease.leaseId !== active.leaseId
      || lease.holderRef !== active.holderRef || lease.fencingRevision !== active.fencingRevision) {
      fail("invalid_broadcast_failover_fence");
    }
    return true;
  }

  acknowledge(scopeInput, eventIdInput) {
    const program = this.#get(scopeInput);
    matches(eventIdInput, BROADCAST_DOMAIN_PATTERNS.sha256, "invalid_broadcast_failover_event");
    const before = program.outbox.length;
    program.outbox = program.outbox.filter((event) => event.eventId !== eventIdInput);
    return before !== program.outbox.length;
  }

  roleSnapshot(scopeInput, role, now = Date.now()) {
    const program = this.#get(scopeInput);
    this.#role(role);
    const state = program.roles.get(role);
    return freeze({
      role,
      active: state.active ? { ...state.active } : null,
      standbys: state.candidates
        .filter((candidate) => candidate.holderRef !== state.active?.holderRef)
        .slice(0, this.#maxStandbys)
        .map((candidate) => ({
          holderRef: candidate.holderRef,
          deviceRef: candidate.deviceRef,
          health: candidate.health,
          consent: candidate.decryptConsent !== "none" && candidate.consentExpiresAt > now
            ? candidate.decryptConsent : "none",
          access: "none",
        })),
      failureSince: state.failureSince,
      lastFailureType: state.lastFailureType,
    });
  }

  snapshot(scopeInput) {
    const program = this.#get(scopeInput);
    return freeze({
      snapshotVersion: 1,
      scope: { ...program.scope },
      fencingRevision: program.fencingRevision,
      stopped: program.stopped,
      roles: [...ROLES].map((role) => {
        const state = program.roles.get(role);
        return {
          role,
          active: state.active ? { ...state.active } : null,
          failureSince: state.failureSince,
          lastFailureType: state.lastFailureType,
        };
      }),
      outbox: program.outbox.map((event) => ({ ...event })),
      sequence: program.sequence,
    });
  }

  restore(snapshotInput) {
    const snapshot = clone(snapshotInput, "invalid_broadcast_failover_snapshot");
    closed(snapshot, new Set(["snapshotVersion", "scope", "fencingRevision", "stopped", "roles", "outbox", "sequence"]), "invalid_broadcast_failover_snapshot");
    if (snapshot.snapshotVersion !== 1 || typeof snapshot.stopped !== "boolean"
      || !Array.isArray(snapshot.roles) || snapshot.roles.length !== ROLES.size
      || !Array.isArray(snapshot.outbox) || snapshot.outbox.length > MAX_OUTBOX) {
      fail("invalid_broadcast_failover_snapshot");
    }
    const scope = normalizeScope(snapshot.scope);
    const forbidden = JSON.stringify(snapshot).toLowerCase();
    if (["media", "sframe", "decryptkey", "transcript", "captiontext"].some((term) => forbidden.includes(`\"${term}\"`))) {
      fail("forbidden_broadcast_recovery_state");
    }
    const program = {
      scope: { ...scope },
      fencingRevision: integer(snapshot.fencingRevision, scope.leaseEpoch, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot"),
      roles: new Map(),
      outbox: snapshot.outbox.map((event) => normalizeOutboxEvent(event, scope)),
      sequence: integer(snapshot.sequence, 0, Number.MAX_SAFE_INTEGER, "invalid_broadcast_failover_snapshot"),
      stopped: snapshot.stopped,
    };
    for (const roleState of snapshot.roles) {
      closed(roleState, new Set(["role", "active", "failureSince", "lastFailureType"]), "invalid_broadcast_failover_snapshot");
      this.#role(roleState.role);
      if (program.roles.has(roleState.role)) fail("invalid_broadcast_failover_snapshot");
      const active = normalizeActive(roleState.active);
      const failureSince = nullableInteger(roleState.failureSince, "invalid_broadcast_failover_snapshot");
      if (roleState.lastFailureType !== null && !FAILURE_TYPES.has(roleState.lastFailureType)) {
        fail("invalid_broadcast_failover_snapshot");
      }
      if (active && active.fencingRevision > program.fencingRevision) fail("invalid_broadcast_failover_snapshot");
      program.roles.set(roleState.role, {
        candidates: [], active, failureSince,
        lastFailureType: roleState.lastFailureType,
      });
    }
    this.#programs.set(scopeKey(scope), program);
    return this.snapshot(scope);
  }

  #get(scopeInput) {
    const scope = normalizeScope(clone(scopeInput));
    const program = this.#programs.get(scopeKey(scope));
    if (!program || program.scope.roomId !== scope.roomId || program.scope.programEpoch !== scope.programEpoch) {
      fail("broadcast_failover_program_not_found");
    }
    return program;
  }

  #role(role) {
    if (!ROLES.has(role)) fail("invalid_broadcast_failover_role");
  }

  #promote(program, role, candidate, now, failureType) {
    const state = program.roles.get(role);
    program.fencingRevision += 1;
    const active = {
      leaseId: leaseId(program.scope, role, program.fencingRevision, candidate.holderRef),
      holderRef: candidate.holderRef,
      deviceRef: candidate.deviceRef,
      fencingRevision: program.fencingRevision,
      issuedAt: now,
      lastHeartbeatAt: now,
      expiresAt: now + this.#leaseTtlMs,
      access: role === "packager-writer" ? "source-and-decrypt" : "gateway-writer",
    };
    state.active = active;
    state.failureSince = null;
    const recovery = recoveryFor(failureType, true);
    this.#emit(program, failureType ? "writer-takeover" : "writer-acquired", role, now, {
      failureType,
      fencingRevision: active.fencingRevision,
      disposition: recovery.disposition,
    });
    return freeze({ action: failureType ? "takeover" : "acquired", failureType, active: { ...active }, recovery });
  }

  #stop(program, role, failureType, now, reasonCode) {
    program.stopped = true;
    for (const roleState of program.roles.values()) roleState.active = null;
    program.fencingRevision += 1;
    const recovery = recoveryFor(failureType, false);
    this.#emit(program, "program-stopped", role, now, {
      failureType,
      fencingRevision: program.fencingRevision,
      disposition: recovery.disposition,
      reasonCode,
    });
    return freeze({ action: "stop", failureType, recovery, reasonCode });
  }

  #emit(program, type, role, occurredAt, fields) {
    if (program.outbox.length >= MAX_OUTBOX) fail("broadcast_failover_outbox_exhausted");
    program.sequence += 1;
    program.outbox.push(freeze({
      eventVersion: 1,
      eventId: eventId(program.scope, program.sequence, type),
      type,
      tenantId: program.scope.tenantId,
      roomId: program.scope.roomId,
      programId: program.scope.programId,
      programEpoch: program.scope.programEpoch,
      role,
      occurredAt,
      ...fields,
    }));
  }
}
