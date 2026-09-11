import crypto from "node:crypto";
import { BroadcastProgramCapacity } from "./broadcast-program-capacity.js";
import { BroadcastProgramHistory } from "./broadcast-program-history.js";
import { BroadcastProgramTransitions } from "./broadcast-program-transitions.js";
import { BroadcastProgramLifetime, normalizeBroadcastProgramRuntime } from "./broadcast-program-lifetime.js";
import { normalizeNativeSourceAudioOutput } from "./native-source-audio-output.js";
import { normalizeNativeSourceVideoOutput, nativeOutputRequestFields } from "./native-source-video-output.js";
import { normalizeNativeStandbySelection, nativeStandbyProjection } from "./native-packager-standby.js";

import { BroadcastAudienceRegistry } from "./broadcast-audience-registry.js";
import { deviceFingerprint } from "./device-proof.js";
import {
  BROADCAST_GRANT_AUDIENCE,
  broadcastGrantPathHash,
} from "./broadcast-grant-policy.js";
import {
  broadcastSubjectRef,
  broadcastTenantRef,
  oidcPrincipal,
} from "./broadcast-identifiers.js";
import { validateBroadcastContract } from "./broadcast-contracts.js";
import {
  applyBroadcastProgramCommand,
  initializeBroadcastProgramMachine,
  renewBroadcastWriterLeases,
} from "./broadcast-program-machine.js";
import { BROADCAST_PROGRAM_STATES, MAX_BROADCAST_IDEMPOTENCY_RECORDS, validateBroadcastProgramMachine } from "./broadcast-program-model.js";

const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE = /^bpc_[A-Za-z0-9_-]{24,64}$/;
const SUBJECT = /^sub_[A-Za-z0-9_-]{16,64}$/;
const VISIBILITY = new Set(["private", "unlisted", "public"]);
const ACTIVE = new Set(["live", "degraded"]);
const WHIP_ACTIONS = new Set(["whip:create", "whip:update", "whip:delete"]);
const MAX_PROGRAMS = 10_000;
const MAX_CHALLENGES = 10_000;
const INACTIVE_PROGRAM_STATES = new Set(["draft", "stopped", "failed"]);
const capacityScope = machine => ({ tenantId: machine.scope.tenantId,
  principalRef: machine.scope.ownerSubjectRef, programId: machine.scope.programId });

function assertCleanupCapacity(machine) {
  if (!INACTIVE_PROGRAM_STATES.has(machine.program.state)
    && machine.appliedCommands.length > MAX_BROADCAST_IDEMPOTENCY_RECORDS - 2) {
    fail("broadcast_program_cleanup_capacity", 429);
  }
}

export class BroadcastRuntimeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "BroadcastRuntimeError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new BroadcastRuntimeError(code, status); }
function unavailable() { fail("broadcast_not_available", 404); }

function clone(value, code = "invalid_broadcast_runtime_input") {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(code); }
  if (serialized === undefined || Buffer.byteLength(serialized) > 128 * 1024) fail(code);
  try { return JSON.parse(serialized); } catch { return fail(code); }
}

function closed(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function identityRefs(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    fail("broadcast_authentication_required", 401);
  }
  return Object.freeze({
    tenantId: broadcastTenantRef(identity.issuer),
    subjectRef: broadcastSubjectRef(identity),
    principal: oidcPrincipal(identity),
  });
}

function command(machine, action, overrides = {}) {
  const value = {
    commandVersion: 1,
    action,
    tenantId: machine.scope.tenantId,
    actorSubjectRef: machine.scope.ownerSubjectRef,
    roomId: machine.scope.roomId,
    programId: machine.scope.programId,
    ...(action === "create" ? {} : {
      expectedRevision: machine.program.revision,
      expectedBroadcastEpoch: machine.epochs.broadcast,
    }),
    ...overrides,
  };
  return Object.freeze({
    ...value,
    idempotencyKeyHash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
}

function entry(record) {
  const { program } = record.snapshot.machine;
  return Object.freeze({
    directoryVersion: 1,
    programId: program.programId,
    title: program.title || "Live-Programm",
    ownerLabel: record.ownerVisibility === "shown" ? record.ownerLabel : null,
    ownerVisibility: record.ownerVisibility,
    visibility: program.visibility,
    availability: ACTIVE.has(program.state) ? program.state : (
      new Set(["stopped", "failed"]).has(program.state) ? "ended" : "offline"
    ),
    viewerCount: record.viewerCount,
    latencyMode: record.latencyMode,
    captions: record.captions,
    programEpoch: program.programEpoch,
    policyRevision: record.snapshot.policy.revision,
    playback: record.snapshot.policy.authentication === "none" ? "public" : "grant-required",
  });
}

function normalizeRegistration(value) {
  const input = clone(value, "invalid_broadcast_runtime_registration");
  closed(input, new Set([
    "machine", "policy", "authorizedViewerSubjectRefs", "resourceRef", "ownerLabel",
    "ownerVisibility", "latencyMode", "captions", "viewerCount",
  ]), "invalid_broadcast_runtime_registration");
  if (!RESOURCE.test(input.resourceRef || "")
    || !new Set(["shown", "hidden"]).has(input.ownerVisibility)
    || (input.ownerVisibility === "shown"
      ? typeof input.ownerLabel !== "string" || input.ownerLabel.length < 1 || input.ownerLabel.length > 80
      : input.ownerLabel !== null)
    || !new Set(["ll-hls", "standard-hls", "moq-experimental"]).has(input.latencyMode)
    || typeof input.captions !== "boolean"
    || !Number.isSafeInteger(input.viewerCount) || input.viewerCount < 0 || input.viewerCount > 1_000_000) {
    fail("invalid_broadcast_runtime_registration");
  }
  return input;
}

export class BroadcastRuntimeRegistry {
  #audience;
  #authority;
  #records = new Map();
  #history = new BroadcastProgramHistory();
  #transitions = new BroadcastProgramTransitions();
  #challenges = new Map();
  #pendingPublishers = new Map();
  #programCapacity;
  #maxProgramRuntimeMs;
  #onProgramExpired;
  #onResourceStopped;
  #challengeTtlMs;
  #clock;
  #idFactory;
  #programIdFactory;
  #policyIdFactory;
  #resourceIdFactory;
  #leaseIdFactory;
  #anonymousSubjectFactory;
  #resourceRefs = new Set();

  constructor({
    grantAuthority,
    audienceRegistry,
    programCapacityLimits,
    maxProgramRuntimeMs,
    onProgramExpired = () => {},
    onResourceStopped = () => {},
    challengeTtlMs = 60_000,
    clock = Date.now,
    idFactory = () => `bpc_${crypto.randomBytes(24).toString("base64url")}`,
    programIdFactory = () => `prg_${crypto.randomBytes(18).toString("base64url")}`,
    policyIdFactory = () => `pol_${crypto.randomBytes(18).toString("base64url")}`,
    resourceIdFactory = () => `res_${crypto.randomBytes(18).toString("base64url")}`,
    leaseIdFactory = () => `lea_${crypto.randomBytes(18).toString("base64url")}`,
    anonymousSubjectFactory = () => `sub_${crypto.randomBytes(18).toString("base64url")}`,
  } = {}) {
    if (!grantAuthority || typeof grantAuthority.issue !== "function"
      || typeof grantAuthority.issueAnonymousPlayback !== "function"
      || !Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 5_000 || challengeTtlMs > 120_000
      || typeof clock !== "function" || typeof idFactory !== "function"
      || typeof programIdFactory !== "function" || typeof policyIdFactory !== "function"
      || typeof resourceIdFactory !== "function" || typeof leaseIdFactory !== "function"
      || typeof anonymousSubjectFactory !== "function" || typeof onProgramExpired !== "function"
      || typeof onResourceStopped !== "function") {
      fail("invalid_broadcast_runtime_configuration", 500);
    }
    this.#authority = grantAuthority;
    this.#programCapacity = new BroadcastProgramCapacity(programCapacityLimits);
    this.#maxProgramRuntimeMs = normalizeBroadcastProgramRuntime(maxProgramRuntimeMs);
    this.#onProgramExpired = onProgramExpired;
    this.#onResourceStopped = onResourceStopped;
    this.#audience = audienceRegistry || new BroadcastAudienceRegistry({
      revokeProgramEpoch: (...args) => this.#authority.revokeProgramEpoch(...args),
    });
    this.#challengeTtlMs = challengeTtlMs;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#programIdFactory = programIdFactory;
    this.#policyIdFactory = policyIdFactory;
    this.#resourceIdFactory = resourceIdFactory;
    this.#leaseIdFactory = leaseIdFactory;
    this.#anonymousSubjectFactory = anonymousSubjectFactory;
  }

  createProgram(identity, member, value, now = this.#clock()) {
    const refs = identityRefs(identity);
    const input = clone(value, "invalid_broadcast_program_request");
    closed(input, new Set(["requestVersion", "roomId", "title", "visibility"]),
      "invalid_broadcast_program_request");
    if (input.requestVersion !== 1 || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(input.roomId || "")
      || typeof input.title !== "string" || input.title.trim().length < 1 || input.title.trim().length > 80
      || !VISIBILITY.has(input.visibility)) fail("invalid_broadcast_program_request");
    if (!member || member.principal !== refs.principal || member.roomId !== input.roomId
      || member.creator !== true || member.deviceFingerprint?.length !== 43) {
      fail("broadcast_program_owner_membership_required", 403);
    }
    const programId = this.#programIdFactory();
    const policyId = this.#policyIdFactory();
    const resourceRef = this.#resourceIdFactory();
    if (!PROGRAM.test(programId) || !/^pol_[A-Za-z0-9_-]{16,64}$/.test(policyId)
      || !RESOURCE.test(resourceRef)) fail("invalid_broadcast_runtime_identifier", 500);
    let machine = initializeBroadcastProgramMachine({
      tenantId: refs.tenantId,
      ownerSubjectRef: refs.subjectRef,
      roomId: input.roomId,
      programId,
    }, { membership: 1, route: 1, topology: 1, broadcast: 1, lease: 1 });
    machine = applyBroadcastProgramCommand(machine, command(machine, "create", {
      visibility: input.visibility,
      title: input.title.trim(),
      viewerPolicyId: policyId,
    }), now).state;
    const publicWithoutAuthentication = input.visibility === "public";
    const policy = validateBroadcastContract({
      contractVersion: 1,
      type: "viewer-policy",
      tenantId: refs.tenantId,
      ownerSubjectRef: refs.subjectRef,
      roomId: input.roomId,
      programId,
      policyId,
      revision: 1,
      programEpoch: machine.program.programEpoch,
      visibility: input.visibility,
      authentication: publicWithoutAuthentication ? "none" : "required",
      directoryListed: publicWithoutAuthentication,
      anonymousAllowed: publicWithoutAuthentication,
      allowedOriginHashes: [],
      updatedAt: now,
    }, { tenantId: refs.tenantId, roomId: input.roomId, programId, programEpoch: 1 });
    const projected = this.register({
      machine,
      policy,
      authorizedViewerSubjectRefs: [],
      resourceRef,
      ownerLabel: identity.displayName,
      ownerVisibility: "shown",
      latencyMode: "ll-hls",
      captions: false,
      viewerCount: 0,
    }, now);
    return Object.freeze({
      program: projected,
      control: Object.freeze({
        tenantId: refs.tenantId,
        roomId: input.roomId,
        programId,
        programRevision: machine.program.revision,
        programEpoch: machine.program.programEpoch,
      }),
    });
  }

  register(value, now = this.#clock()) {
    const input = normalizeRegistration(value);
    const machine = validateBroadcastProgramMachine(input.machine);
    assertCleanupCapacity(machine);
    if (!machine.program || !PROGRAM.test(machine.scope.programId)) {
      fail("invalid_broadcast_runtime_registration");
    }
    if (this.#records.size >= MAX_PROGRAMS) fail("broadcast_program_capacity_reached", 429);
    const key = `${machine.scope.tenantId}\0${machine.scope.programId}`;
    if (this.#records.has(key)) fail("broadcast_program_already_registered", 409);
    if (this.#resourceRefs.has(input.resourceRef)) fail("broadcast_resource_already_registered", 409);
    this.#assertProgramCapacity(machine);
    const snapshot = this.#audience.register({
      machine,
      policy: input.policy,
      authorizedViewerSubjectRefs: input.authorizedViewerSubjectRefs || [],
    }, now);
    const record = Object.freeze({
      snapshot,
      lifetime: INACTIVE_PROGRAM_STATES.has(machine.program.state) ? null : new BroadcastProgramLifetime(this.#maxProgramRuntimeMs, now),
      resourceRef: input.resourceRef,
      ownerLabel: input.ownerLabel,
      ownerVisibility: input.ownerVisibility,
      latencyMode: input.latencyMode,
      captions: input.captions,
      viewerCount: input.viewerCount,
      authorizedViewerSubjectRefs: Object.freeze([...(input.authorizedViewerSubjectRefs || [])]),
      publisherPrincipal: null,
      publisherFingerprint: null,
    });
    this.#records.set(key, record);
    this.#journal(null, record, now);
    this.#resourceRefs.add(input.resourceRef);
    return entry(record);
  }

  listPublic(tenantId) {
    const visible = new Set(this.#audience.listPublic(tenantId).map(({ broadcastProgramId }) => broadcastProgramId));
    return Object.freeze([...this.#records.entries()]
      .filter(([key, record]) => key.startsWith(`${tenantId}\0`) && visible.has(record.snapshot.machine.scope.programId))
      .map(([, record]) => entry(record))
      .sort((left, right) => left.title.localeCompare(right.title) || left.programId.localeCompare(right.programId)));
  }

  listMine(identity) {
    const refs = identityRefs(identity);
    const owned = [];
    const authorized = [];
    for (const [key, record] of this.#records) {
      if (!key.startsWith(`${refs.tenantId}\0`)) continue;
      const program = record.snapshot.machine.program;
      if (program.ownerSubjectRef === refs.subjectRef) owned.push(entry(record));
      else if (record.authorizedViewerSubjectRefs.includes(refs.subjectRef)) authorized.push(entry(record));
    }
    const order = (left, right) => left.title.localeCompare(right.title) || left.programId.localeCompare(right.programId);
    return Object.freeze({ authorized: Object.freeze(authorized.sort(order)), owned: Object.freeze(owned.sort(order)) });
  }

  changeVisibility(identity, programId, value, now = this.#clock()) {
    const refs = identityRefs(identity);
    const input = clone(value, "invalid_broadcast_visibility_request");
    closed(input, new Set(["requestVersion", "visibility"]), "invalid_broadcast_visibility_request");
    if (input.requestVersion !== 1 || !VISIBILITY.has(input.visibility) || !PROGRAM.test(programId || "")) {
      fail("invalid_broadcast_visibility_request");
    }
    const key = `${refs.tenantId}\0${programId}`;
    const record = this.#records.get(key);
    if (!record || record.snapshot.machine.scope.ownerSubjectRef !== refs.subjectRef) unavailable();
    const { machine, policy } = record.snapshot;
    if (!new Set(["draft", "stopped", "failed"]).has(machine.program.state)) {
      fail("broadcast_visibility_restart_required", 409);
    }
    const request = {
      requestVersion: 1,
      tenantId: refs.tenantId,
      roomId: machine.scope.roomId,
      programId,
      expectedProgramRevision: machine.program.revision,
      expectedProgramEpoch: machine.program.programEpoch,
      expectedPolicyRevision: policy.revision,
      visibility: input.visibility,
      authentication: input.visibility === "public" ? "none" : "required",
      anonymousAllowed: input.visibility === "public",
      allowedOriginHashes: [],
    };
    request.idempotencyKeyHash = crypto.createHash("sha256")
      .update(JSON.stringify(request)).digest("hex");
    const snapshot = this.#audience.changeVisibility(request, {
      projectionVersion: 1,
      source: "room-membership",
      active: true,
      tenantId: refs.tenantId,
      roomId: machine.scope.roomId,
      subjectRef: refs.subjectRef,
      role: "owner",
      epoch: machine.epochs.membership,
    }, now);
    const next = Object.freeze({ ...record, snapshot, sourceAuthorityRevision: snapshot.machine.program.revision });
    this.#records.set(key, next);
    this.#journal(record, next, now);
    return entry(next);
  }

  stopProgram(identity, programId, now = this.#clock()) {
    const refs = identityRefs(identity);
    if (!PROGRAM.test(programId || "")) unavailable();
    const key = `${refs.tenantId}\0${programId}`;
    const record = this.#records.get(key);
    if (!record || record.snapshot.machine.scope.ownerSubjectRef !== refs.subjectRef) unavailable();
    return entry(this.#stopRecord(key, record, "OWNER_STOP", now));
  }

  stopProgramsForMember(member, now = this.#clock()) {
    if (!member || typeof member.principal !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(member.deviceFingerprint || "")) return 0;
    const matches = challenge => challenge.kind === "publisher"
      && challenge.refs.principal === member.principal && challenge.proofContext.roomId === member.roomId
      && challenge.memberFingerprint === member.deviceFingerprint
      && (!challenge.memberPeerId || challenge.memberPeerId === member.id);
    for (const [id, challenge] of this.#challenges) if (matches(challenge)) this.#challenges.delete(id);
    for (const transaction of this.#pendingPublishers.values()) {
      if (matches(transaction.challenge)) transaction.abort.abort();
    }
    let stopped = 0;
    for (const [key, record] of [...this.#records.entries()]) {
      if (record.publisherPrincipal !== member.principal
        || record.publisherFingerprint !== member.deviceFingerprint
        || record.snapshot.machine.scope.roomId !== member.roomId
        || record.snapshot.machine.program.state === "stopped") continue;
      this.#stopRecord(key, record, "PUBLISHER_LEFT", now);
      stopped += 1;
    }
    return stopped;
  }

  #stopRecord(key, record, reasonCode, now) {
    this.#pendingPublishers.get(key)?.abort.abort();
    let machine = record.snapshot.machine;
    if (machine.program.state !== "stopped") {
      machine = applyBroadcastProgramCommand(machine, command(machine, "stop", {
        reasonCode,
      }), now).state;
      if (machine.program.state !== "stopped") {
        machine = applyBroadcastProgramCommand(machine, command(machine, "cleanup-complete", {
          reasonCode,
        }), now).state;
      }
      this.#authority.revokeProgramEpoch(
        machine.scope.tenantId,
        machine.scope.programId,
        machine.program.programEpoch,
        now,
      );
    }
    const next = this.#synchronizeRecord(key, { ...record, pendingHandoff: null }, machine, now);
    try { this.#onResourceStopped({ resourceRef: record.resourceRef }); } catch { /* isolated gateway cleanup */ }
    return next;
  }

  async createPlaybackChallenge(identity, programId, now = this.#clock(), anonymousContext = null) {
    const anonymous = identity === null;
    let refs;
    if (anonymous) {
      if (!anonymousContext || typeof anonymousContext !== "object" || Array.isArray(anonymousContext)
        || Object.keys(anonymousContext).some((field) => field !== "tenantId")
        || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(anonymousContext.tenantId || "")) {
        fail("broadcast_authentication_required", 401);
      }
      const subjectRef = this.#anonymousSubjectFactory();
      if (!SUBJECT.test(subjectRef)) fail("invalid_broadcast_runtime_identifier", 500);
      refs = Object.freeze({ tenantId: anonymousContext.tenantId, subjectRef, principal: "" });
    } else {
      refs = identityRefs(identity);
    }
    if (!PROGRAM.test(programId || "")) unavailable();
    this.prune(now);
    if (this.#challenges.size >= MAX_CHALLENGES) fail("broadcast_challenge_capacity_reached", 429);
    const record = this.#records.get(`${refs.tenantId}\0${programId}`);
    if (!record) unavailable();
    const { machine, policy } = record.snapshot;
    const authorization = await this.#audience.authorizeViewer({
      requestVersion: 1,
      tenantId: refs.tenantId,
      programId,
      expectedProgramEpoch: machine.program.programEpoch,
      expectedPolicyRevision: policy.revision,
      authenticated: !anonymous,
      ...(anonymous ? {} : { subjectRef: refs.subjectRef }),
    }, now);
    const challengeId = this.#idFactory();
    if (!CHALLENGE.test(challengeId) || this.#challenges.has(challengeId)) {
      fail("invalid_broadcast_playback_challenge", 500);
    }
    const actions = Object.freeze(["playback:manifest", "playback:segment"]);
    const pathPrefix = `/broadcast/play/${record.resourceRef}`;
    const proofContext = Object.freeze({
      tenantId: refs.tenantId,
      subjectRef: refs.subjectRef,
      roomId: machine.scope.roomId,
      programId,
      programRevision: machine.program.revision,
      programEpoch: machine.program.programEpoch,
      grantKind: "playback",
      tokenAudience: BROADCAST_GRANT_AUDIENCE.playback,
      audienceRef: refs.subjectRef,
      resourceRef: record.resourceRef,
      pathHash: broadcastGrantPathHash(pathPrefix),
      actions,
    });
    const expiresAt = Math.min(now + this.#challengeTtlMs, anonymous ? now + 30_000 : identity.expiresAt,
      record.lifetime.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) fail("broadcast_authentication_required", 401);
    this.#challenges.set(challengeId, Object.freeze({
      kind: "playback", anonymous, challengeId, refs, identity, record, authorization,
      proofContext, pathPrefix, expiresAt,
    }));
    return Object.freeze({
      challengeVersion: 1,
      challengeId,
      proofContext,
      expiresAt,
    });
  }

  async authorizePlayback(identity, programId, value, now = this.#clock()) {
    if (typeof programId !== "string" || !PROGRAM.test(programId)) unavailable();
    const input = clone(value, "invalid_broadcast_playback_authorization");
    closed(input, new Set(["requestVersion", "challengeId", "deviceProof"]),
      "invalid_broadcast_playback_authorization");
    if (input.requestVersion !== 1 || !CHALLENGE.test(input.challengeId || "")
      || !input.deviceProof || typeof input.deviceProof !== "object" || Array.isArray(input.deviceProof)) {
      fail("invalid_broadcast_playback_authorization");
    }
    this.prune(now);
    const challenge = this.#challenges.get(input.challengeId);
    if (!challenge || challenge.kind !== "playback" || challenge.expiresAt <= now
      || challenge.proofContext.programId !== programId) unavailable();
    let refs;
    if (challenge.anonymous) {
      if (identity !== null) unavailable();
      refs = challenge.refs;
    } else {
      refs = identityRefs(identity);
      if (challenge.refs.principal !== refs.principal) unavailable();
    }
    this.#challenges.delete(input.challengeId);
    const current = this.#records.get(`${refs.tenantId}\0${challenge.proofContext.programId}`);
    if (current !== challenge.record
      || current.snapshot.machine.program.revision !== challenge.proofContext.programRevision
      || current.snapshot.machine.program.programEpoch !== challenge.proofContext.programEpoch
      || current.snapshot.policy.revision !== challenge.authorization.policyRevision) unavailable();
    let fingerprint;
    try { fingerprint = deviceFingerprint(input.deviceProof.publicKey); } catch { fail("invalid_broadcast_device_public_key"); }
    const grantRequest = {
      grantVersion: 1,
      kind: "playback",
      roomId: challenge.proofContext.roomId,
      programId: challenge.proofContext.programId,
      programRevision: challenge.proofContext.programRevision,
      programEpoch: challenge.proofContext.programEpoch,
      audienceRef: challenge.proofContext.audienceRef,
      actions: challenge.proofContext.actions,
      resourceRef: challenge.proofContext.resourceRef,
      pathPrefix: challenge.pathPrefix,
      policyId: current.snapshot.policy.policyId,
      policyRevision: current.snapshot.policy.revision,
      deviceProof: input.deviceProof,
    };
    const grantAuthorization = {
      identity: { ...identity, expiresAt: Math.min(identity?.expiresAt ?? Infinity, current.lifetime.expiresAt) },
      membership: null,
      audience: {
        active: true,
        tenantId: refs.tenantId,
        roomId: challenge.proofContext.roomId,
        subjectRef: refs.subjectRef,
        principal: refs.principal,
        role: "viewer",
        deviceFingerprint: fingerprint,
      },
      grantee: {
        authorized: true,
        audienceRef: refs.subjectRef,
        ownerSubjectRef: refs.subjectRef,
        deviceFingerprint: fingerprint,
      },
      program: current.snapshot.machine.program,
      consents: null,
      viewerPolicy: current.snapshot.policy,
    };
    const issued = challenge.anonymous
      ? await this.#authority.issueAnonymousPlayback(grantRequest, {
        audience: { ...challenge.authorization, expiresAt: Math.min(challenge.authorization.expiresAt, current.lifetime.expiresAt) },
        program: current.snapshot.machine.program,
        viewerPolicy: current.snapshot.policy,
        subjectRef: refs.subjectRef,
        deviceFingerprint: fingerprint,
      }, now)
      : await this.#authority.issue(grantRequest, grantAuthorization, now);
    let committedAt;
    try { committedAt = this.#clock(); } catch { committedAt = NaN; }
    this.prune(committedAt);
    if (!Number.isSafeInteger(committedAt) || committedAt < now || committedAt >= challenge.expiresAt
      || committedAt >= issued.grant.expiresAt || this.#records.get(`${refs.tenantId}\0${challenge.proofContext.programId}`) !== current) {
      this.#authority.revokeGrant(issued.grant.grantId, Number.isSafeInteger(committedAt) && committedAt >= now ? committedAt : now);
      unavailable();
    }
    return Object.freeze({
      bootstrapVersion: 1,
      program: entry(current),
      resourceRef: current.resourceRef,
      playbackGrant: issued.token,
      expiresAt: issued.grant.expiresAt,
    });
  }

  createPublisherChallenge(identity, member, programId, value, now = this.#clock()) {
    const refs = identityRefs(identity);
    const input = clone(value, "invalid_broadcast_publisher_challenge");
    closed(input, new Set(["requestVersion", "action", "sourceIds"]),
      "invalid_broadcast_publisher_challenge");
    if (input.requestVersion !== 1 || !WHIP_ACTIONS.has(input.action)
      || !Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 4
      || new Set(input.sourceIds).size !== input.sourceIds.length
      || input.sourceIds.some((sourceId) => !/^src_[A-Za-z0-9_-]{16,64}$/.test(sourceId))) {
      fail("invalid_broadcast_publisher_challenge");
    }
    this.prune(now);
    if (this.#challenges.size >= MAX_CHALLENGES) fail("broadcast_challenge_capacity_reached", 429);
    const record = this.#records.get(`${refs.tenantId}\0${programId}`);
    if (!record) unavailable();
    const current = record.snapshot.machine;
    if (current.scope.ownerSubjectRef !== refs.subjectRef
      || !member || member.principal !== refs.principal || member.roomId !== current.scope.roomId
      || member.deviceFingerprint?.length !== 43) {
      fail("broadcast_publisher_membership_required", 403);
    }
    let candidate = current;
    if (input.action === "whip:create") {
      if (current.program.state !== "draft") fail("broadcast_program_already_started", 409);
      candidate = applyBroadcastProgramCommand(candidate, command(candidate, "source-change", {
        sourceIds: input.sourceIds,
      }), now).state;
      candidate = applyBroadcastProgramCommand(candidate, command(candidate, "start", {
        requiresConsent: false,
      }), now).state;
    } else if (!new Set(["preparing", "publishing", "live", "degraded"]).has(current.program.state)) {
      fail("broadcast_program_not_active", 409);
    }
    const challengeId = this.#idFactory();
    if (!CHALLENGE.test(challengeId) || this.#challenges.has(challengeId)) {
      fail("invalid_broadcast_publisher_challenge", 500);
    }
    const pathPrefix = `/broadcast/ingest/${record.resourceRef}`;
    const proofContext = Object.freeze({
      tenantId: refs.tenantId,
      subjectRef: refs.subjectRef,
      roomId: candidate.scope.roomId,
      programId,
      programRevision: candidate.program.revision,
      programEpoch: candidate.program.programEpoch,
      grantKind: "publisher",
      tokenAudience: BROADCAST_GRANT_AUDIENCE.publisher,
      audienceRef: refs.subjectRef,
      resourceRef: record.resourceRef,
      pathHash: broadcastGrantPathHash(pathPrefix),
      actions: Object.freeze([input.action]),
    });
    const expiresAt = Math.min(now + this.#challengeTtlMs, identity.expiresAt, record.lifetime?.expiresAt ?? Infinity);
    if (expiresAt <= now) fail("broadcast_authentication_required", 401);
    this.#challenges.set(challengeId, Object.freeze({
      kind: "publisher", action: input.action, challengeId, refs, identity, record,
      candidate, memberFingerprint: member.deviceFingerprint, memberPeerId: member.id || null,
      proofContext, pathPrefix, expiresAt,
    }));
    return Object.freeze({ challengeVersion: 1, challengeId, proofContext, expiresAt });
  }

  async authorizePublisher(identity, programId, value, now = this.#clock()) {
    if (typeof programId !== "string" || PROGRAM.exec(programId)?.[0] !== programId) unavailable();
    const input = clone(value, "invalid_broadcast_publisher_authorization");
    closed(input, new Set(["requestVersion", "challengeId", "deviceProof"]),
      "invalid_broadcast_publisher_authorization");
    if (input.requestVersion !== 1 || !CHALLENGE.test(input.challengeId || "")
      || !input.deviceProof || typeof input.deviceProof !== "object" || Array.isArray(input.deviceProof)) {
      fail("invalid_broadcast_publisher_authorization");
    }
    this.prune(now);
    const refs = identityRefs(identity);
    const challenge = this.#challenges.get(input.challengeId);
    if (!challenge || challenge.kind !== "publisher" || challenge.expiresAt <= now
      || challenge.refs.principal !== refs.principal || challenge.proofContext.programId !== programId) unavailable();
    // Bind the authenticated route before consuming a challenge, reserving
    // capacity, issuing a grant or moving a different program out of draft.
    this.#challenges.delete(input.challengeId);
    const key = `${refs.tenantId}\0${challenge.proofContext.programId}`;
    const current = this.#records.get(key);
    if (current !== challenge.record) unavailable();
    let fingerprint;
    try { fingerprint = deviceFingerprint(input.deviceProof.publicKey); } catch {
      fail("invalid_broadcast_device_public_key");
    }
    if (fingerprint !== challenge.memberFingerprint) fail("broadcast_grant_device_mismatch", 403);
    return this.#publisherTransaction(key, challenge, identity.expiresAt, now, () => this.#authority.issue({
      grantVersion: 1,
      kind: "publisher",
      roomId: challenge.proofContext.roomId,
      programId: challenge.proofContext.programId,
      programRevision: challenge.proofContext.programRevision,
      programEpoch: challenge.proofContext.programEpoch,
      audienceRef: refs.subjectRef,
      actions: challenge.proofContext.actions,
      resourceRef: challenge.proofContext.resourceRef,
      pathPrefix: challenge.pathPrefix,
      deviceProof: input.deviceProof,
    }, {
      identity: { ...identity, expiresAt: Math.min(identity.expiresAt, current.lifetime?.expiresAt ?? now + this.#maxProgramRuntimeMs) },
      membership: {
        active: true,
        tenantId: refs.tenantId,
        roomId: challenge.proofContext.roomId,
        subjectRef: refs.subjectRef,
        principal: refs.principal,
        role: "owner",
        deviceFingerprint: fingerprint,
      },
      audience: null,
      grantee: {
        authorized: true,
        audienceRef: refs.subjectRef,
        ownerSubjectRef: refs.subjectRef,
        deviceFingerprint: fingerprint,
      },
      program: challenge.candidate.program,
      consents: null,
      viewerPolicy: null,
    }, now), (issued, committedAt) => {
      let activeRecord = current;
      if (challenge.candidate !== current.snapshot.machine) {
        activeRecord = this.#synchronizeRecord(key, current, challenge.candidate, committedAt);
      }
      activeRecord = Object.freeze({ ...activeRecord, publisherPrincipal: refs.principal,
        publisherFingerprint: fingerprint, publisherPeerId: challenge.memberPeerId });
      this.#records.set(key, activeRecord);
      return Object.freeze({
        authorizationVersion: 1,
        action: challenge.action,
        accessToken: issued.token,
        expiresAt: issued.grant.expiresAt,
        program: Object.freeze({
          tenantId: challenge.candidate.scope.tenantId,
          roomId: challenge.candidate.scope.roomId,
          programId: challenge.candidate.scope.programId,
          programRevision: challenge.candidate.program.revision,
          programEpoch: challenge.candidate.program.programEpoch,
        }),
        resourceRef: current.resourceRef,
      });
    });
  }

  async #publisherTransaction(key, challenge, identityExpiresAt, now, issue, commit) {
    if (this.#pendingPublishers.has(key)) fail("broadcast_publisher_authorization_pending", 409);
    if (this.#pendingPublishers.size >= MAX_CHALLENGES) fail("broadcast_challenge_capacity_reached", 429);
    this.#assertProgramCapacity(challenge.candidate);
    const transaction = { challenge, abort: new AbortController() };
    this.#pendingPublishers.set(key, transaction);
    const timeout = setTimeout(() => transaction.abort.abort(), Math.min(5000, challenge.expiresAt - now));
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new BroadcastRuntimeError("broadcast_not_available", 404));
      transaction.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    const readClock = () => { try { return this.#clock(); } catch { return NaN; } };
    const revoke = result => {
      const observed = readClock();
      this.#authority.revokeGrant(result.grant.grantId, Number.isSafeInteger(observed) && observed >= now ? observed : now);
    };
    let issued;
    try {
      const issuance = Promise.resolve().then(() => {
        if (transaction.abort.signal.aborted) unavailable();
        return issue();
      }).then(result => {
        // Non-cooperative late issuance must not outlive a cancelled caller.
        if (transaction.abort.signal.aborted) { revoke(result); unavailable(); }
        return result;
      });
      issued = await Promise.race([issuance, cancelled]);
      const committedAt = readClock();
      this.prune(committedAt);
      if (transaction.abort.signal.aborted || this.#records.get(key) !== challenge.record
        || !Number.isSafeInteger(committedAt) || committedAt < now
        || committedAt >= challenge.expiresAt || committedAt >= identityExpiresAt
        || committedAt >= issued.grant.expiresAt) unavailable();
      this.#assertProgramCapacity(challenge.candidate);
      return commit(issued, committedAt);
    } catch (error) {
      if (issued) revoke(issued);
      throw error;
    } finally {
      clearTimeout(timeout);
      transaction.abort.signal.removeEventListener("abort", onAbort);
      transaction.abort.abort();
      if (this.#pendingPublishers.get(key) === transaction) this.#pendingPublishers.delete(key);
    }
  }

  prepareNativePublisher(identity, member, programId, value, admit, now = this.#clock()) {
    return this.#prepareNative(identity, member, programId, value, admit, false, now);
  }

  prepareNativeSourceProgram(identity, member, programId, value, admit, now = this.#clock()) {
    return this.#prepareNative(identity, member, programId, value, admit, true, now);
  }

  #prepareNative(identity, member, programId, value, admit, sourceProgram, now) {
    const refs = identityRefs(identity);
    const input = clone(value, "invalid_native_packager_publication_request");
    closed(input, new Set([
      "requestVersion", "trigger", "packagerId", sourceProgram ? "inputMode" : "sourceIds", "requestedRenditions", "allowHardwareAcceleration",
      ...(sourceProgram && [2, 3].includes(input.requestVersion) ? ["audioOutput"] : []),
      ...(sourceProgram && input.requestVersion === 3 ? ["videoOutput"] : []),
    ]), "invalid_native_packager_publication_request");
    if (!(input.requestVersion === 1 || sourceProgram && [2, 3].includes(input.requestVersion)) || input.trigger !== "user-action"
      || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(input.packagerId || "")
      || (sourceProgram ? input.inputMode !== "trusted-sframe-v1" : (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 4
      || new Set(input.sourceIds).size !== input.sourceIds.length
      || input.sourceIds.some((sourceId) => !/^src_[A-Za-z0-9_-]{16,64}$/.test(sourceId))))
      || !Number.isSafeInteger(input.requestedRenditions) || input.requestedRenditions < 1
      || input.requestedRenditions > 3 || typeof input.allowHardwareAcceleration !== "boolean"
      || typeof admit !== "function" || !PROGRAM.test(programId || "")) {
      fail("invalid_native_packager_publication_request");
    }
    if (input.requestVersion === 3) {
      try { input.videoOutput = normalizeNativeSourceVideoOutput(input.videoOutput); }
      catch { fail("invalid_native_packager_publication_request"); }
    }
    if (input.requestVersion === 2 || input.requestVersion === 3 && input.audioOutput !== null) {
      try { input.audioOutput = normalizeNativeSourceAudioOutput(input.audioOutput); }
      catch { fail("invalid_native_packager_publication_request"); }
    }
    const key = `${refs.tenantId}\0${programId}`;
    const record = this.#records.get(key);
    const current = record?.snapshot.machine;
    if (!record || !current || current.scope.ownerSubjectRef !== refs.subjectRef) unavailable();
    if (!member || member.principal !== refs.principal || member.roomId !== current.scope.roomId
      || member.creator !== true || member.deviceFingerprint?.length !== 43) {
      fail("broadcast_publisher_membership_required", 403);
    }
    if (current.program.state !== "draft") fail("broadcast_program_already_started", 409);
    let candidate = applyBroadcastProgramCommand(current, command(current, "source-change", {
      sourceIds: sourceProgram ? [] : input.sourceIds,
    }), now).state;
    candidate = applyBroadcastProgramCommand(candidate, command(candidate, "start", {
      requiresConsent: false,
    }), now).state;
    return this.#installNativeWriter(key, record, candidate, input, admit, member, now);
  }

  #installNativeWriter(key, record, candidate, input, admit, member, now) {
    this.#assertProgramCapacity(candidate);
    const lifetime = record.lifetime || new BroadcastProgramLifetime(this.#maxProgramRuntimeMs, now);
    if (!lifetime.observe(now)) unavailable();
    const programId = candidate.scope.programId;
    const audioOutput = record.nativeAudioOutput ?? input.audioOutput;
    const videoOutput = record.nativeVideoOutput ?? input.videoOutput;
    const admission = admit(Object.freeze({
      ...nativeOutputRequestFields(audioOutput, videoOutput),
      trigger: "user-action",
      tenantId: candidate.scope.tenantId,
      ownerSubjectRef: candidate.scope.ownerSubjectRef,
      roomId: candidate.scope.roomId,
      programId,
      programEpoch: candidate.program.programEpoch,
      resourceRef: record.resourceRef,
      requestedRenditions: input.requestedRenditions,
      allowHardwareAcceleration: input.allowHardwareAcceleration,
    }));
    const leaseId = this.#leaseIdFactory();
    if (!/^lea_[A-Za-z0-9_-]{16,64}$/.test(leaseId || "")) {
      fail("invalid_broadcast_runtime_identifier", 500);
    }
    const lease = {
      contractVersion: 1,
      type: "lease",
      tenantId: candidate.scope.tenantId,
      holderRef: input.packagerId,
      roomId: candidate.scope.roomId,
      programId,
      leaseId,
      revision: 1,
      programEpoch: candidate.epochs.broadcast,
      role: "packager-writer",
      status: "active",
      fencingRevision: candidate.epochs.lease + 1,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: Math.min(now + 60_000, lifetime.expiresAt),
    };
    candidate = applyBroadcastProgramCommand(candidate, command(candidate, "handoff", {
      expectedLeaseEpoch: candidate.epochs.lease,
      lease,
    }), now).state;
    this.#synchronizeRecord(key, {
      ...record, lifetime, pendingHandoff: null,
      ...(audioOutput ? { nativeAudioOutput: audioOutput } : {}),
      ...(videoOutput ? { nativeVideoOutput: videoOutput } : {}),
      publisherPrincipal: member.principal, publisherFingerprint: member.deviceFingerprint,
      publisherPeerId: member.id,
    }, candidate, now);
    return Object.freeze({
      admission,
      lease: Object.freeze({
        leaseId: lease.leaseId,
        fencingRevision: lease.fencingRevision,
        expiresAt: lease.expiresAt,
      }),
      program: Object.freeze({
        tenantId: candidate.scope.tenantId,
        roomId: candidate.scope.roomId,
        programId,
        programRevision: candidate.program.revision,
        programEpoch: candidate.program.programEpoch,
      }),
    });
  }

  #nativeOwned(identity, member, programId, now = this.#clock()) {
    const refs = identityRefs(identity);
    if (!PROGRAM.test(programId || "")) unavailable();
    const key = `${refs.tenantId}\0${programId}`;
    const record = this.#currentRecord(key, now);
    if (!record || record.snapshot.machine.scope.ownerSubjectRef !== refs.subjectRef) unavailable();
    if (!member || member.principal !== refs.principal || member.creator !== true
      || member.roomId !== record.snapshot.machine.scope.roomId
      || !/^[A-Za-z0-9_-]{43}$/.test(member.deviceFingerprint || "")
      || record.publisherPrincipal !== member.principal
      || record.publisherFingerprint !== member.deviceFingerprint
      || record.publisherPeerId !== member.id || !/^[a-f0-9]{16}$/.test(member.id || "")) {
      fail("broadcast_publisher_membership_required", 403);
    }
    return { key, record };
  }

  nativeControl(identity, member, programId) {
    const { record } = this.#nativeOwned(identity, member, programId);
    const machine = record.snapshot.machine;
    const writer = machine.writerLeases.find(({ role }) => role === "packager-writer");
    return Object.freeze({
      controlVersion: 1, programId, programRevision: machine.program.revision,
      programEpoch: machine.program.programEpoch, state: machine.program.state,
      handoffPending: Boolean(record.pendingHandoff),
      writer: writer ? Object.freeze({ packagerId: writer.holderRef, fencingRevision: writer.fencingRevision }) : null,
    });
  }

  nativeStandbyControl(identity, member, programId) {
    const { record } = this.#nativeOwned(identity, member, programId);
    return nativeStandbyProjection(record.snapshot.machine, record.standbyPlan);
  }

  nativeSourceRequestContext(identity, member, programId, now = this.#clock()) {
    const { record } = this.#nativeOwned(identity, member, programId, now);
    const machine = record.snapshot.machine;
    const writer = machine.writerLeases.find(lease => lease.role === "packager-writer");
    if (!ACTIVE.has(machine.program.state) || record.pendingHandoff || !writer || writer.expiresAt <= now) {
      fail("broadcast_source_request_program_unavailable", 409);
    }
    return Object.freeze({ programRevision: machine.program.revision, programEpoch: machine.program.programEpoch,
      packagerRef: writer.holderRef, fencingRevision: writer.fencingRevision });
  }

  // Server-only scope. A valid invitation is not a writer lease or source consent.
  nativeSourceWriterContext(identity, member, programId, now = this.#clock()) {
    const context = this.nativeSourceRequestContext(identity, member, programId, now);
    const { record } = this.#nativeOwned(identity, member, programId, now);
    const machine = record.snapshot.machine;
    const writer = machine.writerLeases.find(lease => lease.role === "packager-writer");
    return Object.freeze({ ...context, tenantId: machine.scope.tenantId,
      sourceAuthorityRevision: record.sourceAuthorityRevision ?? machine.program.revision,
      ownerSubjectRef: machine.scope.ownerSubjectRef, state: machine.program.state,
      leaseId: writer.leaseId, expiresAt: writer.expiresAt });
  }

  selectNativeStandbys(identity, member, programId, value, admit, now = this.#clock()) {
    const { key, record } = this.#nativeOwned(identity, member, programId, now);
    const input = normalizeNativeStandbySelection(value);
    const machine = record.snapshot.machine;
    const current = nativeStandbyProjection(machine, record.standbyPlan);
    const writer = machine.writerLeases.find(lease => lease.role === "packager-writer");
    if (!ACTIVE.has(machine.program.state) || record.pendingHandoff || !writer || writer.expiresAt <= now
      || input.expectedProgramRevision !== current.programRevision
      || input.expectedProgramEpoch !== current.programEpoch
      || input.expectedStandbyRevision !== current.standbyRevision
      || current.standbyRevision === Number.MAX_SAFE_INTEGER) fail("stale_native_standby_selection", 409);
    if (typeof admit !== "function" || input.standbyPackagerIds.includes(writer.holderRef)) {
      fail("invalid_native_standby_selection");
    }
    // Validate every candidate before committing any metadata. No prepare/send calls.
    for (const packagerId of input.standbyPackagerIds) {
      admit(packagerId, Object.freeze({ ...nativeOutputRequestFields(record.nativeAudioOutput, record.nativeVideoOutput), trigger: "user-action",
        tenantId: machine.scope.tenantId, ownerSubjectRef: machine.scope.ownerSubjectRef,
        roomId: machine.scope.roomId, programId, programEpoch: machine.program.programEpoch,
        resourceRef: record.resourceRef, requestedRenditions: input.requestedRenditions,
        allowHardwareAcceleration: input.allowHardwareAcceleration,
      }));
    }
    const standbyPlan = Object.freeze({ programEpoch: current.programEpoch,
      revision: current.standbyRevision + 1, packagerIds: input.standbyPackagerIds });
    const next = Object.freeze({ ...record, standbyPlan });
    this.#records.set(key, next);
    this.#journal(record, next, now);
    return nativeStandbyProjection(machine, standbyPlan);
  }

  beginNativeHandoff(identity, member, programId, value, admit, now = this.#clock()) {
    const { key, record } = this.#nativeOwned(identity, member, programId, now);
    const input = clone(value, "invalid_native_packager_handoff");
    const fields = new Set(["requestVersion", "trigger", "packagerId", "expectedProgramRevision",
      "expectedProgramEpoch", "expectedFencingRevision", "requestedRenditions", "allowHardwareAcceleration"]);
    closed(input, fields, "invalid_native_packager_handoff");
    if (Object.keys(input).length !== fields.size || input.requestVersion !== 1 || input.trigger !== "user-action"
      || typeof input.packagerId !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(input.packagerId)
      || ![input.expectedProgramRevision, input.expectedProgramEpoch, input.expectedFencingRevision].every(n => Number.isSafeInteger(n) && n > 0)
      || !Number.isSafeInteger(input.requestedRenditions) || input.requestedRenditions < 1 || input.requestedRenditions > 3
      || typeof input.allowHardwareAcceleration !== "boolean" || typeof admit !== "function") fail("invalid_native_packager_handoff");
    const machine = record.snapshot.machine;
    if (record.pendingHandoff || machine.program.revision !== input.expectedProgramRevision
      || machine.program.programEpoch !== input.expectedProgramEpoch) fail("stale_broadcast_handoff", 409);
    // Reserve restart, successor, readiness and terminal cleanup before fencing anything.
    if (machine.appliedCommands.length > MAX_BROADCAST_IDEMPOTENCY_RECORDS - 8) {
      fail("broadcast_handoff_capacity_exhausted", 409);
    }
    const writer = machine.writerLeases.find(({ role }) => role === "packager-writer");
    if (!writer || writer.holderRef === input.packagerId || writer.fencingRevision !== input.expectedFencingRevision
      || writer.expiresAt <= now) fail("stale_broadcast_handoff_writer", 409);
    const resourceRef = this.#resourceIdFactory();
    if (!RESOURCE.test(resourceRef || "") || this.#resourceRefs.has(resourceRef)) fail("invalid_broadcast_runtime_identifier", 500);
    const candidate = applyBroadcastProgramCommand(machine, command(machine, "output-restart", {
      expectedLeaseEpoch: machine.epochs.lease, reasonCode: "PACKAGER_HANDOFF",
    }), now).state;
    admit(Object.freeze({ ...nativeOutputRequestFields(record.nativeAudioOutput, record.nativeVideoOutput), trigger: "user-action", tenantId: candidate.scope.tenantId,
      ownerSubjectRef: candidate.scope.ownerSubjectRef, roomId: candidate.scope.roomId, programId,
      programEpoch: candidate.program.programEpoch, resourceRef,
      requestedRenditions: input.requestedRenditions, allowHardwareAcceleration: input.allowHardwareAcceleration,
    }));
    const pending = Object.freeze({ ...input, programId, previousPackagerId: writer.holderRef,
      previousProgramEpoch: machine.program.programEpoch, previousFencingRevision: writer.fencingRevision,
      nextProgramRevision: candidate.program.revision, nextProgramEpoch: candidate.program.programEpoch, resourceRef,
      publisherPeerId: member.id, expiresAt: Math.min(now + 12_000, record.lifetime.expiresAt) });
    this.#synchronizeRecord(key, { ...record, resourceRef, pendingHandoff: pending }, candidate, now);
    this.#resourceRefs.add(resourceRef);
    return pending; // Internal capability, never serialized or accepted from a client.
  }

  completeNativeHandoff(identity, member, pending, admit, now = this.#clock()) {
    const { key, record } = this.#nativeOwned(identity, member, pending?.programId, now);
    if (!pending || record.pendingHandoff !== pending || pending.expiresAt <= now
      || record.snapshot.machine.program.state !== "preparing"
      || record.snapshot.machine.program.revision !== pending.nextProgramRevision
      || record.snapshot.machine.program.programEpoch !== pending.nextProgramEpoch || record.resourceRef !== pending.resourceRef
      || member.id !== pending.publisherPeerId || typeof admit !== "function") fail("stale_broadcast_handoff", 409);
    return this.#installNativeWriter(key, record, record.snapshot.machine, pending, admit, member, now);
  }

  cancelNativeHandoff(identity, pending, now = this.#clock()) {
    const refs = identityRefs(identity);
    const key = `${refs.tenantId}\0${pending?.programId}`;
    const record = this.#records.get(key);
    if (pending && record?.pendingHandoff === pending && record.snapshot.machine.scope.ownerSubjectRef === refs.subjectRef) {
      this.#stopRecord(key, record, "HANDOFF_FAILED", now);
    }
  }

  markPublished(resourceRef, now = this.#clock()) {
    this.prune(now);
    const found = [...this.#records.entries()].find(([, record]) => record.resourceRef === resourceRef);
    if (!found) unavailable();
    const [key, record] = found;
    let machine = record.snapshot.machine;
    if (machine.program.state === "live") return entry(record);
    if (machine.program.state !== "preparing") fail("broadcast_program_not_preparing", 409);
    machine = applyBroadcastProgramCommand(machine, command(machine, "advance", {
      toState: "awaiting_consent",
    }), now).state;
    for (const [role, suffix] of [["packager-writer", "packager"], ["gateway-writer", "gateway"]]) {
      const holderRef = `pkr_${crypto.createHash("sha256").update(`${suffix}\0${resourceRef}`).digest("base64url").slice(0, 24)}`;
      machine = applyBroadcastProgramCommand(machine, command(machine, "handoff", {
        expectedLeaseEpoch: machine.epochs.lease,
        lease: {
          contractVersion: 1,
          type: "lease",
          tenantId: machine.scope.tenantId,
          holderRef,
          roomId: machine.scope.roomId,
          programId: machine.scope.programId,
          leaseId: `lea_${crypto.randomBytes(18).toString("base64url")}`,
          revision: 1,
          programEpoch: machine.epochs.broadcast,
          role,
          status: "active",
          fencingRevision: machine.epochs.lease + 1,
          acquiredAt: now,
          renewedAt: now,
          expiresAt: Math.min(now + 60_000, record.lifetime.expiresAt),
        },
      }), now).state;
    }
    machine = applyBroadcastProgramCommand(machine, command(machine, "advance", {
      toState: "publishing",
    }), now).state;
    machine = applyBroadcastProgramCommand(machine, command(machine, "advance", {
      toState: "live",
    }), now).state;
    return entry(this.#synchronizeRecord(key, record, machine, now));
  }

  markNativeOutputReady(resourceRef, packagerId, fencingRevision, now = this.#clock()) {
    const { key, record, packagerLease } = this.#currentNativeOutput(resourceRef, packagerId, fencingRevision, now);
    let machine = record.snapshot.machine;
    if (machine.program.state === "live") return entry(record);
    if (machine.program.state === "degraded") {
      // A local encoder replacement does not create source or writer authority.
      // The existing gateway and packager leases must both remain fresh.
      machine = applyBroadcastProgramCommand(machine, command(machine, "advance", { toState: "live" }), now).state;
      return entry(this.#synchronizeRecord(key, record, machine, now, true));
    }
    if (machine.program.state !== "preparing") fail("broadcast_program_not_preparing", 409);
    return this.#activateNativeOutput(key, record, packagerLease, now);
  }

  markNativeOutputUnavailable(resourceRef, packagerId, fencingRevision, now = this.#clock()) {
    const { key, record } = this.#currentNativeOutput(resourceRef, packagerId, fencingRevision, now);
    const previous = record.snapshot.machine;
    if (!["publishing", "live"].includes(previous.program.state)) return entry(record);
    const machine = applyBroadcastProgramCommand(previous, command(previous, "advance", { toState: "degraded" }), now).state;
    return entry(this.#synchronizeRecord(key, record, machine, now, true));
  }

  #currentNativeOutput(resourceRef, packagerId, fencingRevision, now, staleCode = "stale_broadcast_packager_output") {
    if (!RESOURCE.test(resourceRef || "") || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId || "")
      || !Number.isSafeInteger(fencingRevision) || fencingRevision < 1 || !Number.isSafeInteger(now)) unavailable();
    const found = [...this.#records.entries()].find(([, record]) => record.resourceRef === resourceRef);
    if (!found) unavailable();
    const [key, record] = found;
    const machine = record.snapshot.machine;
    const packagerLease = machine.writerLeases.find(({ role }) => role === "packager-writer");
    if (!packagerLease || packagerLease.holderRef !== packagerId
      || packagerLease.fencingRevision !== fencingRevision || packagerLease.expiresAt <= now) {
      fail(staleCode, 409);
    }
    if (this.#currentRecord(key, now) !== record) fail(staleCode, 409);
    return { key, record, packagerLease };
  }

  #activateNativeOutput(key, record, packagerLease, now) {
    let machine = record.snapshot.machine;
    const resourceRef = record.resourceRef;
    machine = applyBroadcastProgramCommand(machine, command(machine, "advance", {
      toState: "awaiting_consent",
    }), now).state;
    const gatewayLease = {
      contractVersion: 1,
      type: "lease",
      tenantId: machine.scope.tenantId,
      holderRef: `pkr_${crypto.createHash("sha256").update(`origin\0${resourceRef}`).digest("base64url").slice(0, 24)}`,
      roomId: machine.scope.roomId,
      programId: machine.scope.programId,
      leaseId: `lea_${crypto.randomBytes(18).toString("base64url")}`,
      revision: 1,
      programEpoch: machine.epochs.broadcast,
      role: "gateway-writer",
      status: "active",
      fencingRevision: machine.epochs.lease + 1,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: Math.min(packagerLease.expiresAt, now + 60_000),
    };
    machine = applyBroadcastProgramCommand(machine, command(machine, "handoff", {
      expectedLeaseEpoch: machine.epochs.lease,
      lease: gatewayLease,
    }), now).state;
    machine = applyBroadcastProgramCommand(machine, command(machine, "advance", {
      toState: "publishing",
    }), now).state;
    machine = applyBroadcastProgramCommand(machine, command(machine, "advance", {
      toState: "live",
    }), now).state;
    return entry(this.#synchronizeRecord(key, record, machine, now));
  }

  renewNativeOutput(resourceRef, packagerId, fencingRevision, expiresAt, now = this.#clock()) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 120_000) {
      fail("invalid_broadcast_lease_renewal");
    }
    const { key, record } = this.#currentNativeOutput(resourceRef, packagerId, fencingRevision, now, "stale_broadcast_lease_renewal");
    const machine = renewBroadcastWriterLeases(record.snapshot.machine, {
      holderRef: packagerId, fencingRevision, expiresAt: Math.min(expiresAt, record.lifetime?.expiresAt ?? expiresAt),
    }, now);
    return entry(this.#synchronizeRecord(key, record, machine, now));
  }

  #synchronizeRecord(key, record, machine, now, outputAvailabilityOnly = false) {
    const historyBefore = this.#records.get(key);
    this.#assertProgramCapacity(machine);
    assertCleanupCapacity(machine);
    let lifetime = record.lifetime;
    if (!INACTIVE_PROGRAM_STATES.has(machine.program.state)) {
      lifetime ||= new BroadcastProgramLifetime(this.#maxProgramRuntimeMs, now);
      if (!lifetime.observe(now)) {
        this.#currentRecord(key, now);
        unavailable();
      }
    }
    let policy = record.snapshot.policy;
    if (policy.programEpoch !== machine.program.programEpoch
      || policy.visibility !== machine.program.visibility) {
      policy = validateBroadcastContract({
        ...policy,
        revision: policy.revision + 1,
        programEpoch: machine.program.programEpoch,
        visibility: machine.program.visibility,
        directoryListed: machine.program.visibility === "public",
        updatedAt: now,
      }, {
        tenantId: machine.scope.tenantId,
        roomId: machine.scope.roomId,
        programId: machine.scope.programId,
        programEpoch: machine.program.programEpoch,
      });
      this.#authority.revokeProgramEpoch(
        machine.scope.tenantId,
        machine.scope.programId,
        record.snapshot.machine.program.programEpoch,
        now,
      );
    }
    const snapshot = this.#audience.synchronize({
      machine,
      policy,
      authorizedViewerSubjectRefs: record.authorizedViewerSubjectRefs,
    }, now);
    // Only local output availability and unchanged-revision lease renewal retain
    // existing source authority. First approval still checks the UI revision.
    const sourceAuthorityRevision = outputAvailabilityOnly || machine.program.revision === record.snapshot.machine.program.revision
      ? record.sourceAuthorityRevision ?? record.snapshot.machine.program.revision : machine.program.revision;
    const next = Object.freeze({ ...record, lifetime, snapshot, sourceAuthorityRevision,
      standbyPlan: ACTIVE.has(machine.program.state)
        && record.standbyPlan?.programEpoch === machine.program.programEpoch ? record.standbyPlan : null });
    this.#records.set(key, next);
    this.#journal(historyBefore, next, now);
    return next;
  }

  // Internal post-commit observation only. Never reads/prunes policy or grants authority.
  observeProgramAction(scope, event, now = this.#clock()) {
    try {
      const record = this.#records.get(`${scope.tenantId}\0${scope.programId}`), machine = record?.snapshot.machine;
      if (!machine || ["tenantId", "roomId", "programId", "ownerSubjectRef"].some(k => machine.scope[k] !== scope[k])
        || machine.program.programEpoch !== scope.programEpoch) return false;
      return this.#history.action(record, event, now);
    } catch { return false; } // Advisory observation must never prevent a security transition.
  }

  nativeProgramHistory(identity, member, programId, now = this.#clock(), version = 1) {
    const { record } = this.#nativeOwned(identity, member, programId, now);
    const { machine } = record.snapshot;
    const events = this.#history.list(machine.scope.tenantId, programId, now, version);
    if (!events) fail("broadcast_program_history_unavailable", 503);
    return Object.freeze({ programId, programRevision: machine.program.revision,
      programEpoch: machine.program.programEpoch, events });
  }

  // Both observers are advisory post-commit metadata; neither can reject a transition.
  #journal(before, after, now) {
    this.#history.observe(before, after, now);
    try { this.#transitions.observe(before, after, now); } catch { /* Metrics never own a program transition. */ }
  }

  // Content-free windowed transition durations for the metrics sampler.
  transitionSamples(now = this.#clock()) { return this.#transitions.samples(now); }

  closeProgramHistory() { this.#history.destroy(); this.#transitions.destroy(); }

  prune(now = this.#clock()) {
    this.#history.prune(now);
    this.#transitions.prune(now);
    for (const key of this.#records.keys()) this.#currentRecord(key, now);
    for (const [id, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(id);
    }
    if (Number.isSafeInteger(now) && now > 0) this.#authority.prune?.(now);
  }

  #currentRecord(key, now) {
    const record = this.#records.get(key);
    if (!record?.lifetime || INACTIVE_PROGRAM_STATES.has(record.snapshot.machine.program.state)
      || record.lifetime.observe(now)) return record;
    const effectiveAt = record.lifetime.observedAt;
    const stopped = this.#stopRecord(key, record, "PROGRAM_RUNTIME_EXPIRED", effectiveAt);
    // Policy revocation is committed before best-effort delivery. The native
    // lease itself is capped, so a lost stop command cannot extend its deadline.
    try { this.#onProgramExpired(Object.freeze({ principal: record.publisherPrincipal,
      programId: record.snapshot.machine.scope.programId, reasonCode: "PROGRAM_RUNTIME_EXPIRED", now: effectiveAt })); }
    catch { /* No rollback of the terminal policy decision on delivery failure. */ }
    return stopped;
  }

  // Internal policy port: caller must already own its assignment scope. Never
  // accept this deadline or the scope as authority supplied by a remote agent.
  programLeaseDeadline(scope, now = this.#clock()) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)
      || Object.keys(scope).length !== 3 || Object.keys(scope).some(field => !["tenantId", "programId", "programEpoch"].includes(field))
      || !Number.isSafeInteger(scope.programEpoch) || scope.programEpoch < 1) return null;
    const key = `${scope?.tenantId}\0${scope?.programId}`;
    const previous = this.#records.get(key);
    if (!previous || previous.snapshot.machine.program.programEpoch !== scope?.programEpoch) return null;
    const record = this.#currentRecord(key, now);
    return INACTIVE_PROGRAM_STATES.has(record.snapshot.machine.program.state) ? null : record.lifetime?.expiresAt ?? null;
  }

  #assertProgramCapacity(candidate) {
    if (INACTIVE_PROGRAM_STATES.has(candidate.program.state)) return;
    if (!this.#programCapacity.allows(capacityScope(candidate), this.#occupiedProgramScopes())) fail("broadcast_temporarily_unavailable", 429);
  }

  // Internal read-only advisory port. Scope is supplied by the authenticated
  // preview adapter; this does not grant membership or reserve a program slot.
  allowsNewProgram(scope) {
    return this.#programCapacity.allowsNew(scope, this.#occupiedProgramScopes());
  }

  #occupiedProgramScopes() {
    const occupied = [];
    for (const record of this.#records.values()) {
      if (!INACTIVE_PROGRAM_STATES.has(record.snapshot.machine.program.state)) occupied.push(capacityScope(record.snapshot.machine));
    }
    for (const transaction of this.#pendingPublishers.values()) {
      // Keep the reservation until finally releases it, even after abort. A new
      // start cannot steal capacity during terminal cleanup of the old caller.
      occupied.push(capacityScope(transaction.challenge.candidate));
    }
    return occupied;
  }

  get programCount() { return this.#records.size; }
  // Occupancy vs configured limits only: worst tenant/principal ratios, never IDs.
  programQuotaCounts() {
    const unique = new Map(), tenants = new Map(), principals = new Map();
    for (const scope of this.#occupiedProgramScopes()) {
      unique.set(`${scope.tenantId}\0${scope.programId}`, scope);
    }
    for (const scope of unique.values()) {
      tenants.set(scope.tenantId, (tenants.get(scope.tenantId) || 0) + 1);
      const principal = `${scope.tenantId}\0${scope.principalRef}`;
      principals.set(principal, (principals.get(principal) || 0) + 1);
    }
    const used = unique.size, limits = this.#programCapacity.limits;
    const peak = values => values.length ? Math.max(...values) : 0;
    return Object.freeze({
      programs: Object.freeze({
        deployment: Object.freeze({ used, limit: limits.deployment }),
        gateway: Object.freeze({ used, limit: limits.gateway }),
        tenant: Object.freeze({ used: peak([...tenants.values()]), limit: limits.tenant }),
        principal: Object.freeze({ used: peak([...principals.values()]), limit: limits.principal }),
      }),
    });
  }
  // Control-plane inventory only: never imply decoded media or audience health.
  // Do not pass records, keys or per-program observations across this boundary.
  programStateCounts() {
    const counts = Object.fromEntries(BROADCAST_PROGRAM_STATES.map(state => [state, 0]));
    for (const record of this.#records.values()) {
      const state = record.snapshot.machine.program.state;
      if (!Object.hasOwn(counts, state)) fail("invalid_broadcast_program_state", 500);
      counts[state] += 1;
    }
    return Object.freeze(counts);
  }
  get challengeCount() { return this.#challenges.size; }
}
