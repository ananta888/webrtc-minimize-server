import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastModerationAuditLog,
  BroadcastModerationError,
  authorizeBroadcastModerationAction,
  evaluateNativePackagerCandidates,
  planOwnSourceRevocation,
  planPackagerWriterSelection,
  summarizeBroadcastSourceConsent,
} from "../src/broadcast-moderation-policy.js";

const NOW = 1_800_000_000_000;
const TENANT = "tn_aaaaaaaaaaaaaaaa";
const OWNER = "sub_bbbbbbbbbbbbbbbb";
const MODERATOR = "sub_cccccccccccccccc";
const PRESENTER = "sub_dddddddddddddddd";
const OTHER = "sub_eeeeeeeeeeeeeeee";
const ROOM = "room-alpha";
const PROGRAM = "prg_aaaaaaaaaaaaaaaa";
const SOURCE = "src_aaaaaaaaaaaaaaaa";

const program = Object.freeze({
  contractVersion: 1,
  type: "broadcast-program",
  tenantId: TENANT,
  ownerSubjectRef: OWNER,
  roomId: ROOM,
  programId: PROGRAM,
  revision: 7,
  programEpoch: 11,
  state: "live",
  visibility: "private",
  sourceIds: [SOURCE],
  createdAt: NOW - 10_000,
  updatedAt: NOW - 1_000,
});

function actor(role, subjectRef) {
  return {
    projectionVersion: 1,
    source: role === "viewer" ? "broadcast-audience" : "room-membership",
    active: true,
    tenantId: TENANT,
    roomId: ROOM,
    subjectRef,
    role,
    epoch: 13,
  };
}

function action(actionName, role, subjectRef, fields = {}) {
  return {
    workflowVersion: 1,
    type: "broadcast-moderation-action",
    action: actionName,
    actionId: "bma_aaaaaaaaaaaaaaaa",
    trigger: "user-action",
    tenantId: TENANT,
    roomId: ROOM,
    programId: PROGRAM,
    actorSubjectRef: subjectRef,
    actorRole: role,
    expectedProgramRevision: 7,
    expectedProgramEpoch: 11,
    confirmation: {
      confirmationId: "bcf_aaaaaaaaaaaaaaaa",
      confirmedAt: NOW - 1,
      expiresAt: NOW + 60_000,
    },
    ...fields,
  };
}

const errorCode = (code, status) => (error) => error instanceof BroadcastModerationError
  && error.code === code && (status === undefined || error.status === status);

function source(subjectRef = PRESENTER) {
  return {
    contractVersion: 1,
    type: "program-source",
    tenantId: TENANT,
    subjectRef,
    roomId: ROOM,
    programId: PROGRAM,
    sourceId: SOURCE,
    revision: 2,
    programEpoch: 11,
    kind: "camera",
    trustMode: "own-source",
    state: "active",
    createdAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
  };
}

function capability(agentId, suffix, overrides = {}) {
  return {
    capabilityVersion: 1,
    agentId,
    tenantId: TENANT,
    ownerSubjectRef: OWNER,
    deviceRef: `dev_${suffix.repeat(16)}`,
    agentVersion: "1.0.0",
    ffmpegVersion: "6.1",
    videoEncoders: ["libx264", "h264_vaapi"],
    audioEncoders: ["aac"],
    hardwareClass: "medium",
    cpuClass: "high",
    gpuClass: "integrated",
    uploadClass: "over-15mbit",
    energyClass: "ac",
    health: "healthy",
    maximumRenditions: 3,
    maximumPixelsPerSecond: 1920 * 1080 * 60,
    consentedRoomIds: [ROOM],
    observedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    ...overrides,
  };
}

function selectionRequest(overrides = {}) {
  return {
    selectionVersion: 1,
    tenantId: TENANT,
    ownerSubjectRef: OWNER,
    roomId: ROOM,
    programId: PROGRAM,
    programEpoch: 11,
    resourceRef: "res_aaaaaaaaaaaaaaaa",
    requestedRenditions: 3,
    allowHardwareAcceleration: true,
    requireAcPower: true,
    minimumUploadClass: "5-15mbit",
    operatorAllowedAgentIds: ["mini-pc", "laptop", "battery", "other-owner", "wrong-room"],
    maximumStandbys: 2,
    ...overrides,
  };
}

test("owner and moderator actions require fresh scope and a local bounded confirmation", () => {
  const requested = authorizeBroadcastModerationAction(program, actor("moderator", MODERATOR), action(
    "source-request",
    "moderator",
    MODERATOR,
    { targetSubjectRef: PRESENTER, sourceKind: "screen" },
  ), NOW);
  assert.equal(requested.sourceKind, "screen");
  assert.equal(Object.isFrozen(requested), true);

  assert.equal(authorizeBroadcastModerationAction(program, actor("owner", OWNER), action(
    "layout-change", "owner", OWNER, { layout: "screen-presenter" },
  ), NOW).layout, "screen-presenter");
  assert.equal(authorizeBroadcastModerationAction(program, actor("moderator", MODERATOR), action(
    "program-stop", "moderator", MODERATOR, { reasonCode: "MODERATOR_STOP" },
  ), NOW).reasonCode, "MODERATOR_STOP");

  assert.throws(() => authorizeBroadcastModerationAction(program, actor("moderator", MODERATOR), {
    ...action("layout-change", "moderator", MODERATOR, { layout: "grid" }),
    expectedProgramRevision: 6,
  }, NOW), errorCode("stale_broadcast_revision", 409));
  assert.throws(() => authorizeBroadcastModerationAction(program, actor("moderator", MODERATOR), {
    ...action("layout-change", "moderator", MODERATOR, { layout: "grid" }),
    confirmation: { confirmationId: "bcf_aaaaaaaaaaaaaaaa", confirmedAt: NOW - 200_000, expiresAt: NOW - 1 },
  }, NOW), errorCode("invalid_broadcast_moderation_confirmation"));
  assert.throws(() => authorizeBroadcastModerationAction(program, actor("presenter", PRESENTER), action(
    "layout-change", "presenter", PRESENTER, { layout: "grid" },
  ), NOW), errorCode("broadcast_action_denied", 403));
});

test("a publisher can revoke only their own source and stale pixels are explicitly destroyed", () => {
  const revoke = action("own-source-revoke", "presenter", PRESENTER, {
    targetSubjectRef: PRESENTER,
    sourceId: SOURCE,
    reasonCode: "PUBLISHER_REVOKED",
  });
  const plan = planOwnSourceRevocation(revoke, source(), {
    program,
    actor: actor("presenter", PRESENTER),
  }, NOW);
  assert.equal(plan.retainLastDecodedFrame, false);
  assert.deepEqual(plan.effects, [
    "fence-source-input",
    "revoke-source-decrypt-key",
    "destroy-source-decoder",
    "clear-compositor-surface",
    "replace-with-safe-slate-or-reflow",
    "revoke-source-grants",
  ]);
  assert.throws(() => planOwnSourceRevocation({ ...revoke, targetSubjectRef: OTHER }, source(), {
    program,
    actor: actor("presenter", PRESENTER),
  }, NOW), errorCode("broadcast_own_source_required", 403));
  assert.throws(() => planOwnSourceRevocation(revoke, source(OTHER), {
    program,
    actor: actor("presenter", PRESENTER),
  }, NOW), errorCode("broadcast_own_source_required", 403));
});

test("consent summary exposes state and pseudonymous bindings but no media content", () => {
  const summary = summarizeBroadcastSourceConsent([source()], [], {
    tenantId: TENANT,
    roomId: ROOM,
    programId: PROGRAM,
    programEpoch: 11,
    requireFresh: false,
  }, NOW);
  assert.deepEqual(summary, [{
    sourceId: SOURCE,
    subjectRef: PRESENTER,
    kind: "camera",
    sourceState: "active",
    consentState: "not-required",
    expiresAt: null,
  }]);
  assert.equal(JSON.stringify(summary).includes("label"), false);
});

test("candidate policy rejects foreign, unconsented, weak or battery devices before selection", () => {
  const candidates = [
    capability("mini-pc", "a"),
    capability("laptop", "b", { uploadClass: "5-15mbit", cpuClass: "medium", maximumRenditions: 2 }),
    capability("battery", "c", { energyClass: "battery" }),
    capability("other-owner", "d", { ownerSubjectRef: OTHER }),
    capability("wrong-room", "e", { consentedRoomIds: ["room-other"] }),
  ];
  const evaluated = evaluateNativePackagerCandidates(candidates, selectionRequest(), NOW);
  assert.deepEqual(evaluated.eligible.map(({ agentId }) => agentId), ["mini-pc", "laptop"]);
  assert.deepEqual(evaluated.rejected, [
    { agentId: "battery", reasonCode: "native_packager_energy_policy_rejected" },
    { agentId: "other-owner", reasonCode: "native_packager_owner_scope_mismatch" },
    { agentId: "wrong-room", reasonCode: "native_packager_room_consent_required" },
  ]);

  const plan = planPackagerWriterSelection(evaluated, {
    primaryAgentId: "mini-pc",
    standbyAgentIds: ["laptop"],
  }, 23);
  assert.equal(plan.fencingRevision, 24);
  assert.deepEqual(plan.activeWriter, {
    agentId: "mini-pc",
    deviceRef: "dev_aaaaaaaaaaaaaaaa",
    mayReceiveDecryptKeys: true,
  });
  assert.deepEqual(plan.standbys, [{
    agentId: "laptop",
    deviceRef: "dev_bbbbbbbbbbbbbbbb",
    mayReceiveDecryptKeys: false,
    state: "warm-no-media-key",
  }]);
  assert.throws(() => planPackagerWriterSelection(evaluated, {
    primaryAgentId: "battery",
    standbyAgentIds: [],
  }, 23), errorCode("broadcast_packager_not_eligible", 403));
});

test("packager selection and handoff stay confirmed, fenced and conflict-aware", () => {
  const selected = authorizeBroadcastModerationAction(program, actor("moderator", MODERATOR), action(
    "packager-select", "moderator", MODERATOR, {
      primaryAgentId: "mini-pc",
      standbyAgentIds: ["laptop"],
    },
  ), NOW);
  assert.deepEqual(selected.standbyAgentIds, ["laptop"]);

  const handoff = authorizeBroadcastModerationAction(program, actor("owner", OWNER), action(
    "packager-handoff", "owner", OWNER, {
      primaryAgentId: "laptop",
      expectedLeaseEpoch: 23,
    },
  ), NOW);
  assert.equal(handoff.expectedLeaseEpoch, 23);
  assert.throws(() => authorizeBroadcastModerationAction(program, actor("owner", OWNER), {
    ...handoff,
    primaryAgentId: "mini-pc",
    standbyAgentIds: [],
  }, NOW), errorCode("invalid_broadcast_moderation_action"));
});

test("audit stays bounded and records no labels, captions, keys or media", () => {
  const log = new BroadcastModerationAuditLog();
  const stopped = action("program-stop", "owner", OWNER, { reasonCode: "OWNER_STOP" });
  for (let index = 0; index < 260; index += 1) log.record(stopped, "accepted", null, NOW + index);
  assert.equal(log.list().length, 256);
  const json = JSON.stringify(log.list());
  for (const forbidden of ["sourceLabels", "captions", "decryptKey", "mediaPayload"]) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.equal(Object.isFrozen(log.list()), true);
});
