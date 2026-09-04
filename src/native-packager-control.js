import crypto from "node:crypto";

import { normalizeNativePackagerCapability } from "./native-packager-policy.js";
import { validateCandidate, validateDescription } from "./protocol.js";

const PACKAGER_ID = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{4,64}$/;
const NONCE = /^[A-Za-z0-9_-]{32}$/;
const PROOF = /^[A-Za-z0-9_-]{86}$/;
const AUTH_WINDOW_MS = 30_000;

export class NativePackagerControlError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NativePackagerControlError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new NativePackagerControlError(code, status); }
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

export function nativePackagerAuthMessage(packagerId, nonce, timestamp) {
  return `native-packager-auth-v1\n${packagerId}\n${nonce}\n${timestamp}`;
}

export function nativePackagerEnrollmentMessage(packagerId, nonce, timestamp, token, key) {
  return `native-packager-enroll-v1\n${packagerId}\n${nonce}\n${timestamp}\n${token}\n${key.x}\n${key.y}`;
}

function verify(publicKey, message, proof) {
  try {
    return crypto.verify("sha256", Buffer.from(message), {
      key: crypto.createPublicKey({ key: publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363",
    }, Buffer.from(proof, "base64url"));
  } catch { return false; }
}

export function parseNativePackagerMessage(raw) {
  let value;
  try { value = JSON.parse(String(raw)); } catch { fail("invalid_native_packager_message"); }
  if (value?.type === "enroll") {
    const fields = new Set(["version", "type", "packagerId", "enrollmentToken", "timestamp", "publicKey", "proof"]);
    if (!exact(value, fields) || value.version !== 1 || !PACKAGER_ID.test(value.packagerId || "")
      || !/^[A-Za-z0-9_-]{43}$/.test(value.enrollmentToken || "")
      || !Number.isSafeInteger(value.timestamp) || !PROOF.test(value.proof || "")) fail("invalid_native_packager_enrollment");
    return Object.freeze(value);
  }
  if (value?.type === "authenticate") {
    const fields = new Set(["version", "type", "packagerId", "timestamp", "proof"]);
    if (!exact(value, fields) || value.version !== 1 || !PACKAGER_ID.test(value.packagerId || "")
      || !Number.isSafeInteger(value.timestamp) || !PROOF.test(value.proof || "")) fail("invalid_native_packager_authentication");
    return Object.freeze(value);
  }
  if (value?.type === "capability") {
    const fields = new Set(["version", "type", "capability"]);
    if (!exact(value, fields) || value.version !== 1) fail("invalid_native_packager_capability");
    return Object.freeze(value);
  }
  if (value?.type === "heartbeat") {
    const fields = new Set(["version", "type", "assignmentId", "programEpoch", "state", "observedAt"]);
    if (!exact(value, fields) || value.version !== 1
      || (value.assignmentId !== "" && !/^asn_[A-Za-z0-9_-]{16,64}$/.test(value.assignmentId || ""))
      || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 0
      || !new Set(["idle", "ready", "starting", "running", "degraded", "draining", "failed"]).has(value.state)
      || !Number.isSafeInteger(value.observedAt)) fail("invalid_native_packager_heartbeat");
    return Object.freeze(value);
  }
  if (value?.type === "assignment-status") {
    const fields = new Set([
      "version", "type", "assignmentId", "programEpoch", "fencingRevision", "state", "reasonCode", "observedAt",
    ]);
    if (!exact(value, fields) || value.version !== 1
      || !/^asn_[A-Za-z0-9_-]{16,64}$/.test(value.assignmentId || "")
      || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 1
      || !Number.isSafeInteger(value.fencingRevision) || value.fencingRevision < 1
      || !new Set(["ready", "starting", "running", "degraded", "draining", "stopped", "failed"]).has(value.state)
      || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.reasonCode || "")
      || !Number.isSafeInteger(value.observedAt)) fail("invalid_native_packager_assignment_status");
    return Object.freeze(value);
  }
  if (value?.type === "assignment-signal") {
    const common = new Set([
      "version", "type", "assignmentId", "programEpoch", "fencingRevision", "description", "candidate",
    ]);
    const hasDescription = Object.hasOwn(value, "description");
    const hasCandidate = Object.hasOwn(value, "candidate");
    if (!exact(value, new Set([...common].filter((field) => (
      field !== (hasDescription ? "candidate" : "description")
    )))) || value.version !== 1 || hasDescription === hasCandidate
      || !/^asn_[A-Za-z0-9_-]{16,64}$/.test(value.assignmentId || "")
      || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 1
      || !Number.isSafeInteger(value.fencingRevision) || value.fencingRevision < 1) {
      fail("invalid_native_packager_signal");
    }
    return Object.freeze({
      version: 1,
      type: value.type,
      assignmentId: value.assignmentId,
      programEpoch: value.programEpoch,
      fencingRevision: value.fencingRevision,
      ...(hasDescription
        ? { description: validateDescription(value.description) }
        : { candidate: validateCandidate(value.candidate) }),
    });
  }
  fail("unknown_native_packager_message");
}

export class NativePackagerControlRegistry {
  #store;
  #packagers = new Map();
  #bySocket = new Map();
  #challenges = new Map();
  #roomConsents = new Map();

  constructor({ enrollmentStore, definitions = [] } = {}) {
    this.#store = enrollmentStore || null;
    for (const definition of definitions) this.#packagers.set(definition.id, {
      definition, socket: null, lastSeen: 0, capability: null, heartbeat: null, messages: [],
    });
  }

  get configured() { return this.#packagers.size > 0; }
  get enrollmentEnabled() { return Boolean(this.#store); }

  readiness(now = Date.now()) {
    const active = [...this.#packagers.values()].filter((packager) => (
      packager.socket
      && now - packager.lastSeen <= 60_000
      && packager.capability
      && packager.capability.expiresAt >= now
    ));
    if (active.some(({ capability }) => capability.health === "healthy")) {
      return Object.freeze({ status: "healthy", reasonCode: "NATIVE_READY" });
    }
    if (active.length > 0) {
      return Object.freeze({ status: "degraded", reasonCode: "NATIVE_DEGRADED" });
    }
    return Object.freeze({
      status: this.configured ? "unavailable" : "disabled",
      reasonCode: this.configured ? "NATIVE_OFFLINE" : "NOT_CONFIGURED",
    });
  }

  issueChallenge(socket, now = Date.now()) {
    const challenge = Object.freeze({ nonce: crypto.randomBytes(24).toString("base64url"), expiresAt: now + AUTH_WINDOW_MS });
    this.#challenges.set(socket, challenge);
    return Object.freeze({ version: 1, type: "packager-challenge", ...challenge });
  }

  enroll(socket, message, now = Date.now()) {
    const challenge = this.#consumeChallenge(socket, message.timestamp, now);
    if (!this.#store || this.#packagers.has(message.packagerId)) fail("native_packager_enrollment_failed", 403);
    let pending;
    try { pending = this.#store.pending(message.enrollmentToken, message.packagerId, now); } catch {
      fail("native_packager_enrollment_failed", 403);
    }
    if (!verify(message.publicKey, nativePackagerEnrollmentMessage(
      message.packagerId, challenge.nonce, message.timestamp, message.enrollmentToken, message.publicKey,
    ), message.proof)) fail("native_packager_enrollment_failed", 403);
    let definition;
    try { definition = this.#store.complete({
      enrollmentToken: message.enrollmentToken, packagerId: message.packagerId,
      publicKey: message.publicKey, now,
    }); } catch { fail("native_packager_enrollment_failed", 403); }
    if (definition.ownerPrincipal !== pending.ownerPrincipal) fail("native_packager_enrollment_failed", 403);
    this.#packagers.set(definition.id, {
      definition, socket: null, lastSeen: 0, capability: null, heartbeat: null, messages: [],
    });
    return definition;
  }

  authenticate(socket, message, now = Date.now()) {
    const challenge = this.#consumeChallenge(socket, message.timestamp, now);
    const packager = this.#packagers.get(message.packagerId);
    if (!packager || !verify(packager.definition.publicKey,
      nativePackagerAuthMessage(message.packagerId, challenge.nonce, message.timestamp), message.proof)) {
      fail("native_packager_authentication_failed", 403);
    }
    const replacedSocket = packager.socket && packager.socket !== socket ? packager.socket : null;
    if (replacedSocket) this.#bySocket.delete(replacedSocket);
    packager.socket = socket;
    packager.lastSeen = now;
    packager.capability = null;
    packager.heartbeat = null;
    packager.messages = [];
    this.#bySocket.set(socket, packager);
    this.#store?.markAuthenticated(packager.definition.id, now);
    return Object.freeze({ id: packager.definition.id, replacedSocket });
  }

  setCapability(socket, rawCapability, identityRefs, now = Date.now()) {
    const packager = this.#bySocket.get(socket);
    if (!packager) fail("native_packager_authentication_required", 403);
    const consentedRoomIds = [...(this.#roomConsents.get(packager.definition.id) || new Set())]
      .filter((roomId) => rawCapability.consentedRoomIds?.includes(roomId));
    const capability = normalizeNativePackagerCapability({
      ...rawCapability,
      agentId: packager.definition.id,
      tenantId: identityRefs.tenantId,
      ownerSubjectRef: identityRefs.ownerSubjectRef,
      deviceRef: `dev_${packager.definition.keyFingerprint}`,
      consentedRoomIds,
    }, now);
    packager.capability = capability;
    packager.lastSeen = now;
    return capability;
  }

  heartbeat(socket, heartbeat, now = Date.now()) {
    const packager = this.#bySocket.get(socket);
    if (!packager) fail("native_packager_authentication_required", 403);
    if (Math.abs(now - heartbeat.observedAt) > AUTH_WINDOW_MS) fail("stale_native_packager_heartbeat");
    packager.lastSeen = now;
    packager.heartbeat = heartbeat;
  }

  allowMessage(socket, now = Date.now(), { limit = 120, windowMs = 10_000 } = {}) {
    const packager = this.#bySocket.get(socket);
    if (!packager) return false;
    packager.messages = packager.messages.filter((timestamp) => timestamp > now - windowMs);
    if (packager.messages.length >= limit) return false;
    packager.messages.push(now);
    return true;
  }

  consent(ownerPrincipal, packagerId, roomId, enabled) {
    const packager = this.#packagers.get(packagerId);
    if (!packager || packager.definition.ownerPrincipal !== ownerPrincipal) fail("native_packager_not_found", 404);
    if (!ROOM_ID.test(roomId || "") || typeof enabled !== "boolean") fail("invalid_native_packager_room_consent");
    const rooms = this.#roomConsents.get(packagerId) || new Set();
    if (enabled) rooms.add(roomId); else rooms.delete(roomId);
    if (rooms.size > 20) fail("native_packager_room_consent_limit", 409);
    if (rooms.size) this.#roomConsents.set(packagerId, rooms); else this.#roomConsents.delete(packagerId);
    if (packager.capability) packager.capability = Object.freeze({
      ...packager.capability,
      consentedRoomIds: Object.freeze(packager.capability.consentedRoomIds.filter((id) => rooms.has(id))),
    });
    return Object.freeze({ packagerId, roomId, enabled });
  }

  consentState(packagerId) {
    const packager = this.#packagers.get(packagerId);
    if (!packager) fail("native_packager_not_found", 404);
    return Object.freeze({
      version: 1,
      type: "room-consent-sync",
      roomIds: Object.freeze([...(this.#roomConsents.get(packagerId) || new Set())].sort()),
    });
  }

  socketFor(packagerId) { return this.#packagers.get(packagerId)?.socket || null; }

  candidate(ownerPrincipal, packagerId, now = Date.now()) {
    const packager = this.#packagers.get(packagerId);
    if (!packager || packager.definition.ownerPrincipal !== ownerPrincipal) {
      fail("native_packager_not_found", 404);
    }
    return Object.freeze({
      id: packager.definition.id,
      online: Boolean(packager.socket && now - packager.lastSeen <= 60_000),
      capability: packager.capability,
    });
  }

  list(ownerPrincipal, now = Date.now()) {
    return [...this.#packagers.values()].filter(({ definition }) => definition.ownerPrincipal === ownerPrincipal)
      .map((packager) => Object.freeze({
        id: packager.definition.id,
        label: packager.definition.label,
        platform: packager.definition.platform,
        keyFingerprint: packager.definition.keyFingerprint,
        online: Boolean(packager.socket && now - packager.lastSeen <= 60_000),
        consentedRoomIds: Object.freeze([...(this.#roomConsents.get(packager.definition.id) || new Set())].sort()),
        capability: packager.capability,
        heartbeat: packager.heartbeat,
      }));
  }

  connection(socket) {
    const packager = this.#bySocket.get(socket);
    return packager ? Object.freeze({ id: packager.definition.id, ownerPrincipal: packager.definition.ownerPrincipal }) : null;
  }

  disconnect(socket) {
    this.#challenges.delete(socket);
    const packager = this.#bySocket.get(socket);
    if (!packager) return;
    this.#bySocket.delete(socket);
    if (packager.socket === socket) packager.socket = null;
  }

  revoke(ownerPrincipal, packagerId, now = Date.now()) {
    const packager = this.#packagers.get(packagerId);
    if (!packager || packager.definition.ownerPrincipal !== ownerPrincipal) fail("native_packager_not_found", 404);
    const result = this.#store?.revoke(ownerPrincipal, packagerId, now);
    this.#roomConsents.delete(packagerId);
    this.#bySocket.delete(packager.socket);
    this.#packagers.delete(packagerId);
    return Object.freeze({ ...(result || { packagerId, revokedAt: now }), socket: packager.socket });
  }

  #consumeChallenge(socket, timestamp, now) {
    const challenge = this.#challenges.get(socket);
    this.#challenges.delete(socket);
    if (!challenge || challenge.expiresAt < now || !Number.isSafeInteger(timestamp)
      || Math.abs(now - timestamp) > AUTH_WINDOW_MS || !NONCE.test(challenge.nonce)) {
      fail("native_packager_authentication_failed", 403);
    }
    return challenge;
  }
}
