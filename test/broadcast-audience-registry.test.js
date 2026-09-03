import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BroadcastAudienceError,
  BroadcastAudienceRegistry,
} from "../src/broadcast-audience-registry.js";
import { validateBroadcastContract } from "../src/broadcast-contracts.js";
import { validateBroadcastProgramMachine } from "../src/broadcast-program-machine.js";
import { RoomDirectory } from "../src/room-directory.js";

const NOW = 1_800_000_000_000;
const TENANT_ID = "tn_aaaaaaaaaaaaaaaa";
const OWNER = "sub_bbbbbbbbbbbbbbbb";
const MODERATOR = "sub_cccccccccccccccc";
const PRESENTER = "sub_dddddddddddddddd";
const PACKAGER = "sub_eeeeeeeeeeeeeeee";
const VIEWER = "sub_ffffffffffffffff";
const OTHER = "sub_gggggggggggggggg";
const ORIGIN_HASH = "a".repeat(64);

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const audienceError = (code, status) => (error) => (
  error instanceof BroadcastAudienceError
  && error.code === code
  && (status === undefined || error.status === status)
);

function fixture({ suffix = "a", visibility = "private", state = "live", authentication } = {}) {
  const roomId = `room-${suffix}`;
  const programId = `prg_${suffix.repeat(16)}`;
  const policyId = `pol_${suffix.repeat(16)}`;
  const scope = {
    tenantId: TENANT_ID,
    ownerSubjectRef: OWNER,
    roomId,
    programId,
  };
  const machine = validateBroadcastProgramMachine({
    machineVersion: 1,
    scope,
    epochs: { membership: 11, route: 13, topology: 17, broadcast: 19, lease: 23 },
    program: {
      contractVersion: 1,
      type: "broadcast-program",
      tenantId: TENANT_ID,
      ownerSubjectRef: OWNER,
      roomId,
      programId,
      revision: 5,
      programEpoch: 19,
      state,
      visibility,
      title: `Programm ${suffix.toUpperCase()}`,
      viewerPolicyId: policyId,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
    },
    writerLeases: [],
    appliedCommands: [],
  });
  const publicProgram = visibility === "public";
  const policy = validateBroadcastContract({
    contractVersion: 1,
    type: "viewer-policy",
    tenantId: TENANT_ID,
    ownerSubjectRef: OWNER,
    roomId,
    programId,
    policyId,
    revision: 3,
    programEpoch: machine.program.programEpoch,
    visibility,
    authentication: authentication || (publicProgram ? "none" : "required"),
    directoryListed: publicProgram,
    anonymousAllowed: publicProgram && authentication !== "required",
    allowedOriginHashes: [],
    updatedAt: NOW - 1_000,
  });
  return { machine, policy };
}

function actor(snapshot, role, subjectRef) {
  return {
    projectionVersion: 1,
    source: role === "viewer" ? "broadcast-audience" : "room-membership",
    active: true,
    tenantId: snapshot.machine.scope.tenantId,
    roomId: snapshot.machine.scope.roomId,
    subjectRef,
    role,
    epoch: snapshot.machine.epochs.membership,
  };
}

function visibilityChange(snapshot, visibility, overrides = {}) {
  const publicProgram = visibility === "public";
  const base = {
    requestVersion: 1,
    tenantId: snapshot.machine.scope.tenantId,
    roomId: snapshot.machine.scope.roomId,
    programId: snapshot.machine.scope.programId,
    expectedProgramRevision: snapshot.machine.program.revision,
    expectedProgramEpoch: snapshot.machine.program.programEpoch,
    expectedPolicyRevision: snapshot.policy.revision,
    visibility,
    authentication: publicProgram ? "none" : "required",
    anonymousAllowed: publicProgram,
    allowedOriginHashes: [],
    idempotencyKeyHash: digest(`${visibility}:${snapshot.machine.program.revision}`),
    ...overrides,
  };
  return base;
}

function viewerRequest(snapshot, overrides = {}) {
  return {
    requestVersion: 1,
    tenantId: snapshot.machine.scope.tenantId,
    programId: snapshot.machine.scope.programId,
    expectedProgramEpoch: snapshot.machine.program.programEpoch,
    expectedPolicyRevision: snapshot.policy.revision,
    authenticated: false,
    ...overrides,
  };
}

test("visibility changes private, unlisted and public atomically across program, policy and grants", async () => {
  const revocations = [];
  const registry = new BroadcastAudienceRegistry({
    revokeProgramEpoch: (...values) => {
      revocations.push(values);
      return 2;
    },
  });
  let snapshot = registry.register({
    ...fixture(),
    authorizedViewerSubjectRefs: [VIEWER],
  }, NOW);
  const owner = actor(snapshot, "owner", OWNER);
  const oldViewerRequest = viewerRequest(snapshot, {
    authenticated: true,
    subjectRef: VIEWER,
  });
  assert.equal((await registry.authorizeViewer(oldViewerRequest, NOW)).programEpoch, 19);

  const unlistedRequest = visibilityChange(snapshot, "unlisted");
  snapshot = registry.changeVisibility(unlistedRequest, owner, NOW + 1);
  assert.equal(snapshot.machine.program.visibility, "unlisted");
  assert.equal(snapshot.machine.program.revision, 6);
  assert.equal(snapshot.machine.program.programEpoch, 20);
  assert.equal(snapshot.machine.epochs.lease, 24);
  assert.equal(snapshot.policy.visibility, "unlisted");
  assert.equal(snapshot.policy.revision, 4);
  assert.equal(snapshot.policy.programEpoch, 20);
  assert.equal(snapshot.policy.directoryListed, false);
  assert.equal(revocations.length, 1);
  assert.deepEqual(revocations[0].slice(0, 3), [TENANT_ID, snapshot.machine.program.programId, 19]);
  assert.deepEqual(snapshot.effects.map(({ type }) => type), [
    "fence-previous-writers",
    "revoke-program-grants",
    "reconfigure-delivery-visibility",
    "viewer-policy-changed",
  ]);
  await assert.rejects(
    () => registry.authorizeViewer(oldViewerRequest, NOW + 1),
    audienceError("broadcast_not_available", 404),
  );
  assert.equal((await registry.authorizeViewer(viewerRequest(snapshot, {
    authenticated: true,
    subjectRef: VIEWER,
  }), NOW + 1)).programEpoch, 20);

  const duplicate = registry.changeVisibility(unlistedRequest, owner, NOW + 2);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.machine.program.revision, 6);
  assert.equal(duplicate.policy.revision, 4);
  assert.equal(revocations.length, 1);

  snapshot = registry.changeVisibility(
    visibilityChange(snapshot, "public", { allowedOriginHashes: [ORIGIN_HASH] }),
    owner,
    NOW + 3,
  );
  assert.equal(snapshot.machine.program.programEpoch, 21);
  assert.equal(snapshot.policy.visibility, "public");
  assert.deepEqual(snapshot.policy.allowedOriginHashes, [ORIGIN_HASH]);
  assert.equal(registry.listPublic(TENANT_ID).length, 1);

  snapshot = registry.changeVisibility(
    visibilityChange(snapshot, "private"),
    owner,
    NOW + 4,
  );
  assert.equal(snapshot.machine.program.programEpoch, 22);
  assert.equal(snapshot.policy.visibility, "private");
  assert.deepEqual(registry.listPublic(TENANT_ID), []);
  assert.equal(revocations.length, 3);
});

test("a failed epoch revoke leaves program, policy and public directory on the previous snapshot", async () => {
  const registry = new BroadcastAudienceRegistry({
    revokeProgramEpoch() {
      throw new Error("revoker unavailable");
    },
  });
  const snapshot = registry.register(fixture({ visibility: "public" }), NOW);
  assert.equal(registry.listPublic(TENANT_ID).length, 1);
  assert.throws(
    () => registry.changeVisibility(
      visibilityChange(snapshot, "private"),
      actor(snapshot, "owner", OWNER),
      NOW + 1,
    ),
    /revoker unavailable/,
  );
  assert.equal(registry.listPublic(TENANT_ID).length, 1);
  const stillPublic = await registry.authorizeViewer(viewerRequest(snapshot), NOW + 2);
  assert.equal(stillPublic.programEpoch, snapshot.machine.program.programEpoch);
  assert.equal(stillPublic.policyRevision, snapshot.policy.revision);
});

test("public directory exposes only minimal broadcast metadata and never private or unlisted entries", () => {
  const registry = new BroadcastAudienceRegistry();
  const publicSnapshot = registry.register(fixture({ suffix: "a", visibility: "public" }), NOW);
  registry.register({
    ...fixture({ suffix: "b", visibility: "private" }),
    authorizedViewerSubjectRefs: [VIEWER],
  }, NOW);
  registry.register({
    ...fixture({ suffix: "c", visibility: "unlisted" }),
    authorizedViewerSubjectRefs: [VIEWER],
  }, NOW);
  registry.register(fixture({ suffix: "d", visibility: "public", state: "preparing" }), NOW);

  assert.deepEqual(registry.listPublic(TENANT_ID), [{
    contractVersion: 1,
    type: "broadcast-directory-entry",
    broadcastProgramId: publicSnapshot.machine.program.programId,
    title: "Programm A",
    broadcastVisibility: "public",
    availability: "live",
  }]);
  const serialized = JSON.stringify(registry.listPublic(TENANT_ID));
  for (const forbidden of ["roomId", "ownerSubjectRef", "participant", "viewerCount", "updatedAt", "tenantId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("viewer decisions are playback-only and unauthorized private IDs are indistinguishable", async () => {
  const delays = [];
  const registry = new BroadcastAudienceRegistry({
    minimumViewerDecisionMs: 25,
    viewerDecisionDelay: async (milliseconds) => delays.push(milliseconds),
    viewerDecisionClock: () => 0,
  });
  const privateSnapshot = registry.register({
    ...fixture({ suffix: "b", visibility: "private" }),
    authorizedViewerSubjectRefs: [VIEWER],
  }, NOW);
  const unlistedSnapshot = registry.register({
    ...fixture({ suffix: "c", visibility: "unlisted" }),
    authorizedViewerSubjectRefs: [VIEWER],
  }, NOW);
  const publicSnapshot = registry.register(fixture({
    suffix: "a",
    visibility: "public",
  }), NOW);

  const anonymous = await registry.authorizeViewer(viewerRequest(publicSnapshot), NOW + 1);
  assert.deepEqual(anonymous.actions, ["playback:manifest", "playback:segment"]);
  assert.equal(anonymous.anonymous, true);
  for (const forbidden of [
    "membership", "peerId", "sessionTicket", "sframe", "chat", "capture", "publish",
  ]) assert.equal(Object.hasOwn(anonymous, forbidden), false, forbidden);

  const entitled = await registry.authorizeViewer(viewerRequest(privateSnapshot, {
    authenticated: true,
    subjectRef: VIEWER,
  }), NOW + 1);
  assert.equal(entitled.subjectRef, VIEWER);
  assert.equal(entitled.type, "broadcast-playback-only");
  assert.equal((await registry.authorizeViewer(viewerRequest(unlistedSnapshot, {
    authenticated: true,
    subjectRef: VIEWER,
  }), NOW + 1)).programId, unlistedSnapshot.machine.program.programId);

  const failures = [];
  for (const request of [
    viewerRequest(privateSnapshot, { authenticated: true, subjectRef: OTHER }),
    {
      ...viewerRequest(privateSnapshot, { authenticated: true, subjectRef: OTHER }),
      programId: "prg_zzzzzzzzzzzzzzzz",
    },
  ]) {
    try {
      await registry.authorizeViewer(request, NOW + 1);
      assert.fail("viewer request must fail");
    } catch (error) {
      failures.push({ code: error.code, message: error.message, status: error.status });
    }
  }
  assert.deepEqual(failures, [
    { code: "broadcast_not_available", message: "broadcast_not_available", status: 404 },
    { code: "broadcast_not_available", message: "broadcast_not_available", status: 404 },
  ]);
  assert.deepEqual(delays, [25, 25, 25, 25, 25]);
});

test("origin and policy epochs fail closed for both anonymous and authenticated viewers", async () => {
  const registry = new BroadcastAudienceRegistry();
  const snapshot = registry.register(fixture({ visibility: "public" }), NOW);
  const restricted = registry.changeVisibility(
    visibilityChange(snapshot, "public", {
      authentication: "optional",
      anonymousAllowed: true,
      allowedOriginHashes: [ORIGIN_HASH],
    }),
    actor(snapshot, "owner", OWNER),
    NOW + 1,
  );
  await assert.rejects(
    () => registry.authorizeViewer(viewerRequest(restricted), NOW + 2),
    audienceError("broadcast_not_available", 404),
  );
  assert.equal((await registry.authorizeViewer(viewerRequest(restricted, {
    originHash: ORIGIN_HASH,
  }), NOW + 2)).anonymous, true);
  await assert.rejects(
    () => registry.authorizeViewer(viewerRequest(restricted, {
      expectedProgramEpoch: snapshot.machine.program.programEpoch,
      originHash: ORIGIN_HASH,
    }), NOW + 2),
    audienceError("broadcast_not_available", 404),
  );
});

test("server role policy separates owner, moderator, presenter, packager and viewer actions", () => {
  const registry = new BroadcastAudienceRegistry();
  const snapshot = registry.register(fixture(), NOW);
  const cases = [
    ["owner", OWNER, "program:stop"],
    ["owner", OWNER, "program:visibility"],
    ["moderator", MODERATOR, "source:revoke"],
    ["moderator", MODERATOR, "program:stop"],
    ["moderator", MODERATOR, "packager:handoff"],
    ["presenter", PRESENTER, "source:publish", { targetSubjectRef: PRESENTER }],
    ["packager", PACKAGER, "packager:operate"],
    ["viewer", VIEWER, "playback:view"],
  ];
  for (const [role, subjectRef, action, context] of cases) {
    assert.equal(
      registry.authorizeAction(TENANT_ID, snapshot.machine.program.programId, actor(
        snapshot,
        role,
        subjectRef,
      ), action, context).action,
      action,
    );
  }
  for (const [role, subjectRef, action, context] of [
    ["presenter", PRESENTER, "program:stop"],
    ["presenter", PRESENTER, "source:revoke", { targetSubjectRef: OTHER }],
    ["packager", PACKAGER, "packager:handoff"],
    ["viewer", VIEWER, "source:publish"],
    ["owner", OTHER, "program:visibility"],
  ]) {
    assert.throws(
      () => registry.authorizeAction(
        TENANT_ID,
        snapshot.machine.program.programId,
        actor(snapshot, role, subjectRef),
        action,
        context,
      ),
      audienceError("broadcast_action_denied"),
    );
  }
});

test("broadcast visibility never mutates or expands the existing room directory policy", () => {
  const rooms = new RoomDirectory({ idleTtlMs: 60_000 });
  rooms.create({
    roomId: "room-a",
    title: "Privater Raum",
    visibility: "private",
    ownerPrincipal: "issuer|owner",
  }, NOW);
  const before = rooms.list({ principal: "issuer|owner" });

  const registry = new BroadcastAudienceRegistry();
  const snapshot = registry.register(fixture(), NOW);
  registry.changeVisibility(
    visibilityChange(snapshot, "public"),
    actor(snapshot, "owner", OWNER),
    NOW + 1,
  );

  assert.deepEqual(rooms.list({ principal: "issuer|owner" }), before);
  assert.equal(rooms.list().publicRooms.length, 0);
  assert.equal(registry.listPublic(TENANT_ID).length, 1);
});
