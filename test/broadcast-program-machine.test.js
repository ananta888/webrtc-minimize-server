import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BroadcastProgramError,
  applyBroadcastProgramCommand,
  initializeBroadcastProgramMachine,
  synchronizeBroadcastRoomEpochs,
  validateBroadcastProgramMachine,
} from "../src/broadcast-program-machine.js";
import { authorizeBroadcastWriterCommand } from "../src/broadcast-writer-fencing.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_bbbbbbbbbbbbbbbb",
  roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa",
});
const INITIAL_EPOCHS = Object.freeze({
  membership: 11,
  route: 13,
  topology: 17,
  broadcast: 19,
  lease: 23,
});

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const errorCode = (code) => (error) => error instanceof BroadcastProgramError && error.code === code;

function command(state, action, overrides = {}) {
  const value = {
    commandVersion: 1,
    action,
    tenantId: SCOPE.tenantId,
    actorSubjectRef: SCOPE.ownerSubjectRef,
    roomId: SCOPE.roomId,
    programId: SCOPE.programId,
    ...(action === "create" ? {} : {
      expectedRevision: state.program.revision,
      expectedBroadcastEpoch: state.epochs.broadcast,
    }),
    ...overrides,
  };
  return { ...value, idempotencyKeyHash: hash(JSON.stringify(value)) };
}

function apply(state, action, overrides = {}, now = NOW) {
  return applyBroadcastProgramCommand(state, command(state, action, overrides), now);
}

function lease(state, role, suffix, overrides = {}) {
  return {
    contractVersion: 1,
    type: "lease",
    tenantId: SCOPE.tenantId,
    holderRef: `pkr_${suffix.repeat(16)}`,
    roomId: SCOPE.roomId,
    programId: SCOPE.programId,
    leaseId: `lea_${suffix.repeat(16)}`,
    revision: 1,
    programEpoch: state.epochs.broadcast,
    role,
    status: "active",
    fencingRevision: state.epochs.lease + 1,
    acquiredAt: NOW,
    renewedAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function createDraft() {
  const empty = initializeBroadcastProgramMachine(SCOPE, INITIAL_EPOCHS);
  return apply(empty, "create", { visibility: "private", title: "Pilot" }).state;
}

function createPreparing() {
  return apply(createDraft(), "start", { requiresConsent: true }, NOW + 1).state;
}

function handoff(state, role, suffix, now = NOW + 2) {
  return apply(state, "handoff", {
    expectedLeaseEpoch: state.epochs.lease,
    lease: lease(state, role, suffix),
  }, now).state;
}

function createPublishing() {
  let state = createPreparing();
  state = apply(state, "advance", { toState: "awaiting_consent" }, NOW + 2).state;
  state = handoff(state, "packager-writer", "c", NOW + 3);
  state = handoff(state, "gateway-writer", "d", NOW + 4);
  return apply(state, "advance", { toState: "publishing" }, NOW + 5).state;
}

function createLive() {
  return apply(createPublishing(), "advance", { toState: "live" }, NOW + 6).state;
}

test("program lifecycle covers every state and retry creates a fresh broadcast epoch", () => {
  let state = initializeBroadcastProgramMachine(SCOPE, INITIAL_EPOCHS);
  assert.equal(state.program, null);
  assert.deepEqual(state.epochs, INITIAL_EPOCHS);

  state = apply(state, "create", { visibility: "private" }).state;
  assert.equal(state.program.state, "draft");
  state = apply(state, "start", { requiresConsent: true }, NOW + 1).state;
  assert.equal(state.program.state, "preparing");
  state = apply(state, "advance", { toState: "awaiting_consent" }, NOW + 2).state;
  assert.equal(state.program.state, "awaiting_consent");
  state = handoff(state, "packager-writer", "c", NOW + 3);
  state = handoff(state, "gateway-writer", "d", NOW + 4);
  state = apply(state, "advance", { toState: "publishing" }, NOW + 5).state;
  assert.equal(state.program.state, "publishing");
  state = apply(state, "advance", { toState: "live" }, NOW + 6).state;
  assert.equal(state.program.state, "live");
  state = apply(state, "advance", { toState: "degraded" }, NOW + 7).state;
  assert.equal(state.program.state, "degraded");
  state = apply(state, "advance", { toState: "live" }, NOW + 8).state;
  assert.equal(state.program.state, "live");
  state = apply(state, "fail", { reasonCode: "GATEWAY_FAILED" }, NOW + 9).state;
  assert.equal(state.program.state, "failed");

  const roomEpochs = { ...state.epochs };
  state = apply(state, "retry", { reasonCode: "OPERATOR_RETRY" }, NOW + 10).state;
  assert.equal(state.program.state, "preparing");
  assert.equal(state.epochs.broadcast, roomEpochs.broadcast + 1);
  assert.equal(state.epochs.lease, roomEpochs.lease + 1);
  assert.equal(state.program.programEpoch, state.epochs.broadcast);
  assert.equal(state.writerLeases.length, 0);
  assert.equal(Object.isFrozen(state), true);
});

test("required operations are idempotent and stale or reordered commands fail closed", () => {
  const empty = initializeBroadcastProgramMachine(SCOPE, INITIAL_EPOCHS);
  const create = command(empty, "create", { visibility: "private" });
  const created = applyBroadcastProgramCommand(empty, create, NOW);
  const duplicateCreate = applyBroadcastProgramCommand(created.state, create, NOW + 1);
  assert.equal(duplicateCreate.duplicate, true);
  assert.deepEqual(duplicateCreate.effects, []);
  assert.equal(duplicateCreate.state.program.revision, 1);

  const start = command(created.state, "start", { requiresConsent: false });
  const started = applyBroadcastProgramCommand(created.state, start, NOW + 1);
  assert.equal(started.effects.filter((item) => item.type === "prepare-program").length, 1);
  const lateDuplicate = applyBroadcastProgramCommand(started.state, start, NOW + 2);
  assert.equal(lateDuplicate.duplicate, true);
  assert.deepEqual(lateDuplicate.effects, []);

  assert.throws(
    () => applyBroadcastProgramCommand(started.state, {
      ...start,
      requiresConsent: true,
    }, NOW + 2),
    errorCode("broadcast_idempotency_key_reused"),
  );
  assert.throws(
    () => apply(started.state, "advance", {
      expectedRevision: 1,
      toState: "awaiting_consent",
    }, NOW + 2),
    errorCode("stale_broadcast_revision"),
  );
  assert.throws(
    () => apply(started.state, "advance", { toState: "degraded" }, NOW + 2),
    errorCode("invalid_broadcast_transition"),
  );

  const awaiting = apply(started.state, "advance", { toState: "awaiting_consent" }, NOW + 2).state;
  const repeatedState = apply(awaiting, "advance", { toState: "awaiting_consent" }, NOW + 3);
  assert.equal(repeatedState.state.program.revision, awaiting.program.revision);
  assert.deepEqual(repeatedState.effects, []);

  const stopped = apply(created.state, "stop", { reasonCode: "OWNER_STOP" }, NOW + 2).state;
  assert.equal(stopped.program.state, "stopped");
  assert.throws(
    () => apply(stopped, "start", { requiresConsent: false }, NOW + 3),
    errorCode("invalid_broadcast_start_state"),
  );
  assert.throws(
    () => apply(stopped, "retry", { reasonCode: "OPERATOR_RETRY" }, NOW + 3),
    errorCode("invalid_broadcast_retry_state"),
  );

  for (const action of ["create", "start", "source-change", "handoff", "revoke", "stop", "retry"]) {
    const base = action === "create" ? empty : started.state;
    const candidate = command(base, action, action === "create"
      ? { visibility: "private" }
      : action === "start" ? { requiresConsent: false }
        : action === "source-change" ? { sourceIds: [] }
          : action === "handoff" ? { expectedLeaseEpoch: base.epochs.lease, lease: lease(base, "packager-writer", "e") }
            : action === "revoke" ? { target: "source", targetRef: "src_eeeeeeeeeeeeeeee", reasonCode: "SOURCE_REVOKED" }
              : { reasonCode: "OPERATOR_RETRY" });
    delete candidate.idempotencyKeyHash;
    assert.throws(
      () => applyBroadcastProgramCommand(base, candidate, NOW + 3),
      BroadcastProgramError,
      `${action} requires an idempotency hash`,
    );
  }
});

test("membership, route, topology, broadcast and lease epochs remain independent", () => {
  let state = createPreparing();
  state = synchronizeBroadcastRoomEpochs(state, { membership: 12, topology: 18 });
  assert.deepEqual(state.epochs, {
    membership: 12,
    route: 13,
    topology: 18,
    broadcast: 19,
    lease: 23,
  });
  assert.throws(
    () => synchronizeBroadcastRoomEpochs(state, { membership: 11 }),
    errorCode("stale_broadcast_room_epoch"),
  );

  const changed = apply(state, "source-change", {
    sourceIds: ["src_eeeeeeeeeeeeeeee"],
  }, NOW + 2).state;
  assert.equal(changed.epochs.membership, 12);
  assert.equal(changed.epochs.route, 13);
  assert.equal(changed.epochs.topology, 18);
  assert.equal(changed.epochs.broadcast, 20);
  assert.equal(changed.epochs.lease, 24);
  assert.throws(
    () => apply(changed, "start", {
      expectedBroadcastEpoch: 19,
      requiresConsent: false,
    }, NOW + 3),
    errorCode("stale_broadcast_epoch"),
  );
});

test("packager and gateway commands require current revision and an unexpired exact fence", () => {
  const state = createPublishing();
  const packager = state.writerLeases.find((candidate) => candidate.role === "packager-writer");
  const writerCommand = {
    commandVersion: 1,
    type: "broadcast-writer-command",
    action: "publish",
    tenantId: SCOPE.tenantId,
    roomId: SCOPE.roomId,
    programId: SCOPE.programId,
    programRevision: state.program.revision,
    programEpoch: state.epochs.broadcast,
    leaseEpoch: state.epochs.lease,
    role: packager.role,
    leaseId: packager.leaseId,
    holderRef: packager.holderRef,
    fencingRevision: packager.fencingRevision,
    operationRef: "res_ffffffffffffffff",
  };
  assert.deepEqual(authorizeBroadcastWriterCommand(state, writerCommand, NOW + 6), writerCommand);
  for (const [patch, code] of [
    [{ programRevision: state.program.revision - 1 }, "stale_broadcast_revision"],
    [{ programEpoch: state.epochs.broadcast + 1 }, "stale_broadcast_epoch"],
    [{ leaseEpoch: state.epochs.lease - 1 }, "stale_broadcast_lease_epoch"],
    [{ fencingRevision: packager.fencingRevision + 1 }, "invalid_broadcast_writer_fence"],
  ]) {
    assert.throws(
      () => authorizeBroadcastWriterCommand(state, { ...writerCommand, ...patch }, NOW + 6),
      errorCode(code),
    );
  }
  assert.throws(
    () => authorizeBroadcastWriterCommand(state, writerCommand, packager.expiresAt),
    errorCode("expired_broadcast_writer_fence"),
  );
  assert.throws(
    () => authorizeBroadcastWriterCommand(state, { ...writerCommand, mediaPayload: "no" }, NOW + 6),
    errorCode("invalid_broadcast_writer_command"),
  );
});

test("competing writer handoffs accept at most one holder per role and epoch", () => {
  const base = createPreparing();
  const first = command(base, "handoff", {
    expectedLeaseEpoch: base.epochs.lease,
    lease: lease(base, "packager-writer", "f"),
  });
  const second = command(base, "handoff", {
    expectedLeaseEpoch: base.epochs.lease,
    lease: lease(base, "packager-writer", "g"),
  });
  const won = applyBroadcastProgramCommand(base, first, NOW + 2);
  assert.equal(won.state.writerLeases.length, 1);
  assert.equal(won.state.writerLeases[0].holderRef, "pkr_ffffffffffffffff");
  assert.throws(
    () => applyBroadcastProgramCommand(won.state, second, NOW + 2),
    errorCode("stale_broadcast_revision"),
  );
  const duplicate = applyBroadcastProgramCommand(won.state, first, NOW + 3);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.writerLeases.length, 1);

  assert.throws(
    () => validateBroadcastProgramMachine({
      ...won.state,
      writerLeases: [
        ...won.state.writerLeases,
        lease(won.state, "packager-writer", "h", {
          fencingRevision: won.state.epochs.lease,
        }),
      ],
    }),
    errorCode("duplicate_active_broadcast_writer"),
  );
});

test("leave, logout, room end, consent revoke and source end converge on cleanup", () => {
  for (const trigger of ["leave", "logout", "room-ended", "consent-revoked", "source-ended"]) {
    const live = createLive();
    const stopping = apply(live, "lifecycle", {
      trigger,
      reasonCode: trigger.replaceAll("-", "_").toUpperCase(),
    }, NOW + 7);
    assert.equal(stopping.state.program.state, "stopping", trigger);
    assert.deepEqual(
      stopping.effects.map(({ type }) => type),
      ["revoke-program-grants", "stop-delivery", "cleanup-program-sources"],
      trigger,
    );
    const stopped = apply(stopping.state, "cleanup-complete", {
      reasonCode: "CLEANUP_COMPLETE",
    }, NOW + 8).state;
    assert.equal(stopped.program.state, "stopped", trigger);
    assert.equal(stopped.writerLeases.length, 0, trigger);
  }

  const withSource = apply(createLive(), "source-change", {
    sourceIds: ["src_eeeeeeeeeeeeeeee"],
  }, NOW + 7).state;
  const repeatedSources = apply(withSource, "source-change", {
    sourceIds: ["src_eeeeeeeeeeeeeeee"],
  }, NOW + 8);
  assert.equal(repeatedSources.state.epochs.broadcast, withSource.epochs.broadcast);
  assert.deepEqual(repeatedSources.effects, []);

  const revoked = apply(withSource, "revoke", {
    target: "source",
    targetRef: "src_eeeeeeeeeeeeeeee",
    reasonCode: "SOURCE_REVOKED",
  }, NOW + 8).state;
  assert.equal(revoked.program.state, "stopping");
  assert.deepEqual(revoked.program.sourceIds, []);
});

test("lease loss degrades and recovers while stale loss cannot evict a successor", () => {
  const live = createLive();
  const lost = live.writerLeases.find((candidate) => candidate.role === "packager-writer");
  const degraded = apply(live, "lifecycle", {
    trigger: "lease-lost",
    role: lost.role,
    leaseId: lost.leaseId,
    fencingRevision: lost.fencingRevision,
    reasonCode: "LEASE_LOST",
  }, NOW + 7);
  assert.equal(degraded.state.program.state, "degraded");
  assert.equal(degraded.state.writerLeases.some(({ role }) => role === lost.role), false);
  assert.equal(degraded.effects.some(({ type }) => type === "request-writer-handoff"), true);

  const recoveredLease = lease(degraded.state, "packager-writer", "i");
  const handedOff = apply(degraded.state, "handoff", {
    expectedLeaseEpoch: degraded.state.epochs.lease,
    lease: recoveredLease,
  }, NOW + 8).state;
  const publishing = apply(handedOff, "advance", { toState: "publishing" }, NOW + 9).state;
  const recovered = apply(publishing, "advance", { toState: "live" }, NOW + 10).state;
  assert.equal(recovered.program.state, "live");

  assert.throws(
    () => apply(recovered, "lifecycle", {
      trigger: "lease-lost",
      role: lost.role,
      leaseId: lost.leaseId,
      fencingRevision: lost.fencingRevision,
      reasonCode: "LATE_LEASE_EVENT",
    }, NOW + 11),
    errorCode("stale_broadcast_writer_event"),
  );
});

test("process abort enters failed cleanup and stopped programs never revive", () => {
  const live = createLive();
  const gateway = live.writerLeases.find((candidate) => candidate.role === "gateway-writer");
  const failed = apply(live, "lifecycle", {
    trigger: "process-abort",
    role: gateway.role,
    leaseId: gateway.leaseId,
    fencingRevision: gateway.fencingRevision,
    reasonCode: "PROCESS_ABORT",
  }, NOW + 7).state;
  assert.equal(failed.program.state, "failed");

  const retried = apply(failed, "retry", { reasonCode: "AUTOMATIC_RETRY" }, NOW + 8).state;
  assert.equal(retried.program.state, "preparing");
  assert.equal(retried.writerLeases.length, 0);

  const failedAgain = apply(retried, "fail", { reasonCode: "GATEWAY_FAILED" }, NOW + 9).state;
  const stopped = apply(failedAgain, "cleanup-complete", {
    reasonCode: "CLEANUP_COMPLETE",
  }, NOW + 10).state;
  assert.equal(stopped.program.state, "stopped");
  assert.throws(
    () => apply(stopped, "source-change", { sourceIds: [] }, NOW + 11),
    errorCode("invalid_broadcast_source_change_state"),
  );
});
