import crypto from "node:crypto";

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
} from "./broadcast-program-machine.js";
import { validateBroadcastProgramMachine } from "./broadcast-program-model.js";

const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE = /^bpc_[A-Za-z0-9_-]{24,64}$/;
const SUBJECT = /^sub_[A-Za-z0-9_-]{16,64}$/;
const VISIBILITY = new Set(["private", "unlisted", "public"]);
const ACTIVE = new Set(["live", "degraded"]);
const WHIP_ACTIONS = new Set(["whip:create", "whip:update", "whip:delete"]);
const MAX_PROGRAMS = 10_000;
const MAX_CHALLENGES = 10_000;

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
  #challenges = new Map();
  #challengeTtlMs;
  #clock;
  #idFactory;
  #programIdFactory;
  #policyIdFactory;
  #resourceIdFactory;

  constructor({
    grantAuthority,
    audienceRegistry,
    challengeTtlMs = 60_000,
    clock = Date.now,
    idFactory = () => `bpc_${crypto.randomBytes(24).toString("base64url")}`,
    programIdFactory = () => `prg_${crypto.randomBytes(18).toString("base64url")}`,
    policyIdFactory = () => `pol_${crypto.randomBytes(18).toString("base64url")}`,
    resourceIdFactory = () => `res_${crypto.randomBytes(18).toString("base64url")}`,
  } = {}) {
    if (!grantAuthority || typeof grantAuthority.issue !== "function"
      || !Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 5_000 || challengeTtlMs > 120_000
      || typeof clock !== "function" || typeof idFactory !== "function"
      || typeof programIdFactory !== "function" || typeof policyIdFactory !== "function"
      || typeof resourceIdFactory !== "function") {
      fail("invalid_broadcast_runtime_configuration", 500);
    }
    this.#authority = grantAuthority;
    this.#audience = audienceRegistry || new BroadcastAudienceRegistry({
      revokeProgramEpoch: (...args) => this.#authority.revokeProgramEpoch(...args),
    });
    this.#challengeTtlMs = challengeTtlMs;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#programIdFactory = programIdFactory;
    this.#policyIdFactory = policyIdFactory;
    this.#resourceIdFactory = resourceIdFactory;
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
    const publicWithoutAnonymous = input.visibility === "public";
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
      authentication: "required",
      directoryListed: publicWithoutAnonymous,
      anonymousAllowed: false,
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
    if (!machine.program || !PROGRAM.test(machine.scope.programId)) {
      fail("invalid_broadcast_runtime_registration");
    }
    if (this.#records.size >= MAX_PROGRAMS) fail("broadcast_program_capacity_reached", 429);
    const key = `${machine.scope.tenantId}\0${machine.scope.programId}`;
    if (this.#records.has(key)) fail("broadcast_program_already_registered", 409);
    const snapshot = this.#audience.register({
      machine,
      policy: input.policy,
      authorizedViewerSubjectRefs: input.authorizedViewerSubjectRefs || [],
    }, now);
    const record = Object.freeze({
      snapshot,
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
    const request = {
      requestVersion: 1,
      tenantId: refs.tenantId,
      roomId: machine.scope.roomId,
      programId,
      expectedProgramRevision: machine.program.revision,
      expectedProgramEpoch: machine.program.programEpoch,
      expectedPolicyRevision: policy.revision,
      visibility: input.visibility,
      authentication: "required",
      anonymousAllowed: false,
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
    const next = Object.freeze({ ...record, snapshot });
    this.#records.set(key, next);
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
    return this.#synchronizeRecord(key, record, machine, now);
  }

  async createPlaybackChallenge(identity, programId, now = this.#clock()) {
    const refs = identityRefs(identity);
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
      authenticated: true,
      subjectRef: refs.subjectRef,
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
    const expiresAt = Math.min(now + this.#challengeTtlMs, identity.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) fail("broadcast_authentication_required", 401);
    this.#challenges.set(challengeId, Object.freeze({
      kind: "playback", challengeId, refs, identity, record, authorization, proofContext, pathPrefix, expiresAt,
    }));
    return Object.freeze({
      challengeVersion: 1,
      challengeId,
      proofContext,
      expiresAt,
    });
  }

  async authorizePlayback(identity, value, now = this.#clock()) {
    const input = clone(value, "invalid_broadcast_playback_authorization");
    closed(input, new Set(["requestVersion", "challengeId", "deviceProof"]),
      "invalid_broadcast_playback_authorization");
    if (input.requestVersion !== 1 || !CHALLENGE.test(input.challengeId || "")
      || !input.deviceProof || typeof input.deviceProof !== "object" || Array.isArray(input.deviceProof)) {
      fail("invalid_broadcast_playback_authorization");
    }
    this.prune(now);
    const refs = identityRefs(identity);
    const challenge = this.#challenges.get(input.challengeId);
    this.#challenges.delete(input.challengeId);
    if (!challenge || challenge.kind !== "playback" || challenge.expiresAt <= now
      || challenge.refs.principal !== refs.principal) unavailable();
    const current = this.#records.get(`${refs.tenantId}\0${challenge.proofContext.programId}`);
    if (current !== challenge.record
      || current.snapshot.machine.program.revision !== challenge.proofContext.programRevision
      || current.snapshot.machine.program.programEpoch !== challenge.proofContext.programEpoch
      || current.snapshot.policy.revision !== challenge.authorization.policyRevision) unavailable();
    let fingerprint;
    try { fingerprint = deviceFingerprint(input.deviceProof.publicKey); } catch { fail("invalid_broadcast_device_public_key"); }
    const issued = await this.#authority.issue({
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
    }, {
      identity,
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
    }, now);
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
    const expiresAt = Math.min(now + this.#challengeTtlMs, identity.expiresAt);
    if (expiresAt <= now) fail("broadcast_authentication_required", 401);
    this.#challenges.set(challengeId, Object.freeze({
      kind: "publisher", action: input.action, challengeId, refs, identity, record,
      candidate, memberFingerprint: member.deviceFingerprint, proofContext, pathPrefix, expiresAt,
    }));
    return Object.freeze({ challengeVersion: 1, challengeId, proofContext, expiresAt });
  }

  async authorizePublisher(identity, value, now = this.#clock()) {
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
    this.#challenges.delete(input.challengeId);
    if (!challenge || challenge.kind !== "publisher" || challenge.expiresAt <= now
      || challenge.refs.principal !== refs.principal) unavailable();
    const key = `${refs.tenantId}\0${challenge.proofContext.programId}`;
    const current = this.#records.get(key);
    if (current !== challenge.record) unavailable();
    let fingerprint;
    try { fingerprint = deviceFingerprint(input.deviceProof.publicKey); } catch {
      fail("invalid_broadcast_device_public_key");
    }
    if (fingerprint !== challenge.memberFingerprint) fail("broadcast_grant_device_mismatch", 403);
    const issued = await this.#authority.issue({
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
      identity,
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
    }, now);
    let activeRecord = current;
    if (challenge.candidate !== current.snapshot.machine) {
      try { activeRecord = this.#synchronizeRecord(key, current, challenge.candidate, now); } catch (error) {
        this.#authority.revokeGrant(issued.grant.grantId, now);
        throw error;
      }
    }
    activeRecord = Object.freeze({
      ...activeRecord,
      publisherPrincipal: refs.principal,
      publisherFingerprint: fingerprint,
    });
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
  }

  markPublished(resourceRef, now = this.#clock()) {
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
          expiresAt: now + 60_000,
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

  #synchronizeRecord(key, record, machine, now) {
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
    const next = Object.freeze({ ...record, snapshot });
    this.#records.set(key, next);
    return next;
  }

  prune(now = this.#clock()) {
    for (const [id, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(id);
    }
    this.#authority.prune?.(now);
  }

  get programCount() { return this.#records.size; }
  get challengeCount() { return this.#challenges.size; }
}
