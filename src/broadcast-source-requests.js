import crypto from "node:crypto";
import { oidcPrincipal } from "./broadcast-identifiers.js";

const COMMON = ["requestVersion", "action", "roomId", "deviceFingerprint"];
const ACTIONS = Object.freeze({
  create: ["trigger", "programId", "expectedProgramRevision", "expectedProgramEpoch", "targetPeerId", "sourceKind"],
  "create-own": ["trigger", "programId", "expectedProgramRevision", "expectedProgramEpoch", "sourceKind"],
  list: [], decline: ["trigger", "requestId"], cancel: ["trigger", "requestId"],
});
const TTL = 120_000;
const KINDS = new Set(["microphone", "camera", "screen", "screen-audio"]);
export class BroadcastSourceRequestError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new BroadcastSourceRequestError(code, status); };

function normalize(input) {
  const extra = input && typeof input.action === "string" && Object.hasOwn(ACTIONS, input.action) ? ACTIONS[input.action] : null;
  if (!extra || typeof input !== "object" || Array.isArray(input)) fail("invalid_broadcast_source_request");
  const fields = [...COMMON, ...extra];
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))
    || input.requestVersion !== 1 || typeof input.roomId !== "string" || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(input.roomId)
    || typeof input.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.deviceFingerprint)
    || (input.action !== "list" && input.trigger !== "user-action")) fail("invalid_broadcast_source_request");
  if (["create", "create-own"].includes(input.action) && (typeof input.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(input.programId)
    || ![input.expectedProgramRevision, input.expectedProgramEpoch].every(n => Number.isSafeInteger(n) && n > 0)
    || input.action === "create" && (typeof input.targetPeerId !== "string" || !/^[a-f0-9]{16}$/.test(input.targetPeerId))
    || !KINDS.has(input.sourceKind))) fail("invalid_broadcast_source_request");
  if (["decline", "cancel"].includes(input.action)
    && (typeof input.requestId !== "string" || !/^bsr_[A-Za-z0-9_-]{24}$/.test(input.requestId))) fail("invalid_broadcast_source_request");
  return Object.freeze({ ...input });
}

function binding(peer) {
  return Object.freeze({ id: peer.id, principal: peer.principal, fingerprint: peer.deviceFingerprint });
}
function matches(peer, bound) {
  return peer?.authenticated === true && peer.machine !== true && peer.id === bound.id
    && peer.principal === bound.principal && peer.deviceFingerprint === bound.fingerprint;
}

// Invitations only. This port has no Capture, consent, assignment, key or media API.
export class BroadcastSourceRequests {
  #records = new Map();
  #calls = new Map();
  #members;
  #program;
  #clock;
  #id;
  #closed = false;
  constructor({ members, program, clock = Date.now, idFactory = () => `bsr_${crypto.randomBytes(18).toString("base64url")}` }) {
    if ([members, program, clock, idFactory].some(fn => typeof fn !== "function")) fail("invalid_broadcast_source_request_configuration", 500);
    this.#members = members; this.#program = program; this.#clock = clock; this.#id = idFactory;
  }

  execute(identity, raw) {
    if (this.#closed) fail("broadcast_source_requests_closed", 503);
    const input = normalize(raw), now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 1 || now > Number.MAX_SAFE_INTEGER - TTL) fail("invalid_broadcast_source_request_clock", 500);
    const principal = oidcPrincipal(identity);
    const members = this.#members(input.roomId);
    const actor = members.find(peer => peer.principal === principal && peer.deviceFingerprint === input.deviceFingerprint);
    if (!actor || !matches(actor, binding(actor))) fail("broadcast_source_request_membership_required", 403);
    this.#rate(principal, now);
    this.#refresh(now);
    if (["create", "create-own"].includes(input.action)) return this.#create(identity, actor, members, input, now);
    const accessible = [...this.#records.values()].filter(record => record.roomId === input.roomId
      && (matches(actor, record.owner) || matches(actor, record.target)));
    if (input.action === "list") return this.#response(accessible);
    const record = accessible.find(candidate => candidate.requestId === input.requestId);
    if (!record || !matches(actor, input.action === "decline" ? record.target : record.owner)) {
      fail("broadcast_source_request_unavailable", 404);
    }
    const state = input.action === "decline" ? "declined" : "cancelled";
    if (record.state !== "pending" && record.state !== state) fail("stale_broadcast_source_request", 409);
    record.state = state;
    return this.#response([record]);
  }

  #create(identity, actor, members, input, now) {
    const context = this.#program(identity, actor, input.programId, now);
    if (context.programRevision !== input.expectedProgramRevision || context.programEpoch !== input.expectedProgramEpoch) {
      fail("stale_broadcast_source_request", 409);
    }
    const own = input.action === "create-own";
    const target = own ? actor : members.find(peer => peer.id === input.targetPeerId);
    if (!target || !own && actor.id === target.id || !matches(target, binding(target))) fail("broadcast_source_request_target_unavailable", 404);
    const records = [...this.#records.values()];
    if (records.some(record => record.programId === input.programId && matches(target, record.target)
      && record.sourceKind === input.sourceKind && record.state === "pending")) fail("broadcast_source_request_pending", 409);
    // Terminal records remain until TTL: cancel/decline must not reset the flood budget.
    if (records.length >= 1024 || records.filter(record => record.programId === input.programId).length >= 20
      || records.filter(record => record.owner.principal === actor.principal).length >= 20
      || records.filter(record => record.target.principal === target.principal).length >= 20) {
      fail("broadcast_source_request_quota", 429);
    }
    const requestId = this.#id();
    if (typeof requestId !== "string" || !/^bsr_[A-Za-z0-9_-]{24}$/.test(requestId) || this.#records.has(requestId)) {
      fail("invalid_broadcast_source_request_identifier", 500);
    }
    const record = { requestId, roomId: input.roomId, programId: input.programId,
      programRevision: context.programRevision, programEpoch: context.programEpoch,
      packagerRef: context.packagerRef, fencingRevision: context.fencingRevision,
      sourceKind: input.sourceKind, state: "pending", createdAt: now, expiresAt: now + TTL,
      owner: binding(actor), target: binding(target), identity: Object.freeze({ issuer: identity.issuer, subject: identity.subject }) };
    this.#records.set(requestId, record);
    return this.#response([record]);
  }

  // Internal metadata resolution for a separate explicit-consent authority.
  // Never serialize this result to a client: it contains verified owner identity.
  resolveForPublisher(identity, roomId, deviceFingerprint, requestId) {
    const visible = this.execute(identity, { requestVersion: 1, action: "list", roomId, deviceFingerprint });
    const view = visible.requests.find(value => value.requestId === requestId && value.state === "pending");
    const record = view && this.#records.get(requestId);
    if (!record || record.target.principal !== oidcPrincipal(identity)
      || record.target.fingerprint !== deviceFingerprint) fail("broadcast_source_request_unavailable", 404);
    return Object.freeze({ requestId, roomId, programId: record.programId,
      programRevision: record.programRevision, programEpoch: record.programEpoch,
      packagerRef: record.packagerRef, fencingRevision: record.fencingRevision,
      sourceKind: record.sourceKind, expiresAt: record.expiresAt,
      owner: record.owner, publisher: record.target, ownerIdentity: record.identity });
  }

  #refresh(now) {
    for (const [id, record] of this.#records) {
      if (record.expiresAt <= now) { this.#records.delete(id); continue; }
      if (record.state !== "pending") continue;
      try {
        const members = this.#members(record.roomId), owner = members.find(peer => matches(peer, record.owner));
        if (now < record.createdAt || !owner || !members.some(peer => matches(peer, record.target))) throw new Error();
        const current = this.#program(record.identity, owner, record.programId, now);
        if (["programRevision", "programEpoch", "packagerRef", "fencingRevision"].some(key => current[key] !== record[key])) throw new Error();
      } catch { record.state = "invalidated"; }
    }
  }

  #rate(principal, now) {
    for (const [key, value] of this.#calls) if (value.expiresAt <= now) this.#calls.delete(key);
    let counter = this.#calls.get(principal);
    if (!counter) {
      if (this.#calls.size >= 2048) fail("broadcast_source_request_rate", 429);
      counter = { count: 0, expiresAt: now + 60_000 }; this.#calls.set(principal, counter);
    }
    if (++counter.count > 60) fail("broadcast_source_request_rate", 429);
  }

  prune(now = this.#clock()) {
    if (this.#closed || !Number.isSafeInteger(now) || now < 1) return;
    this.#refresh(now);
    for (const [key, value] of this.#calls) if (value.expiresAt <= now) this.#calls.delete(key);
  }

  destroy() { this.#closed = true; this.#records.clear(); this.#calls.clear(); }

  #response(records) {
    return Object.freeze({ responseVersion: 1, requests: Object.freeze(records.map(record => Object.freeze({
      requestId: record.requestId, roomId: record.roomId, programId: record.programId,
      programRevision: record.programRevision, programEpoch: record.programEpoch,
      ownerPeerId: record.owner.id, targetPeerId: record.target.id, packagerRef: record.packagerRef,
      sourceKind: record.sourceKind, state: record.state, createdAt: record.createdAt,
      expiresAt: record.expiresAt, authority: "none",
    }))) });
  }
}
