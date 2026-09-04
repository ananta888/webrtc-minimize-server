import crypto from "node:crypto";

import { admitNativePackager } from "./native-packager-policy.js";

const PACKAGER = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const ASSIGNMENT = /^asn_[A-Za-z0-9_-]{16,64}$/;
const LEASE = /^lea_[A-Za-z0-9_-]{16,64}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const ACTIVE_STATES = new Set(["preparing", "ready", "starting", "running", "degraded", "draining"]);
const REPORTED_STATES = new Set(["ready", "starting", "running", "degraded", "draining", "stopped", "failed"]);

export class NativePackagerAssignmentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NativePackagerAssignmentError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new NativePackagerAssignmentError(code, status); }

function clone(value, code = "invalid_native_packager_assignment") {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(code); }
  if (serialized === undefined || Buffer.byteLength(serialized) > 16 * 1024) fail(code);
  try { return JSON.parse(serialized); } catch { return fail(code); }
}

function exact(value, fields, code = "invalid_native_packager_assignment") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function snapshot(record) {
  return Object.freeze({
    assignmentId: record.assignmentId,
    packagerId: record.packagerId,
    roomId: record.roomId,
    programId: record.programId,
    programEpoch: record.programEpoch,
    fencingRevision: record.fencingRevision,
    profileId: record.admission.profileId,
    renditionIds: Object.freeze(record.admission.renditions.map(({ id }) => id)),
    state: record.state,
    reasonCode: record.reasonCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  });
}

export class NativePackagerAssignmentRegistry {
  #control;
  #assignments = new Map();
  #byPackager = new Map();
  #byProgram = new Map();
  #idFactory;

  constructor({
    controlRegistry,
    idFactory = () => `asn_${crypto.randomBytes(18).toString("base64url")}`,
  } = {}) {
    if (!controlRegistry || typeof controlRegistry.candidate !== "function"
      || typeof idFactory !== "function") fail("invalid_native_packager_assignment_configuration", 500);
    this.#control = controlRegistry;
    this.#idFactory = idFactory;
  }

  admit(ownerPrincipal, packagerId, request, now = Date.now()) {
    const packager = this.#control.candidate(ownerPrincipal, packagerId, now);
    if (!packager.online || !packager.capability) fail("native_packager_offline", 503);
    return admitNativePackager(packager.capability, request, now);
  }

  prepare(ownerPrincipal, packagerId, admissionValue, leaseValue, now = Date.now()) {
    const admission = clone(admissionValue);
    const lease = clone(leaseValue);
    exact(lease, new Set(["leaseId", "fencingRevision", "expiresAt"]));
    if (!PACKAGER.test(packagerId || "") || !LEASE.test(lease.leaseId || "")
      || !Number.isSafeInteger(lease.fencingRevision) || lease.fencingRevision < 1
      || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + 120_000) {
      fail("invalid_native_packager_assignment");
    }
    const packager = this.#control.candidate(ownerPrincipal, packagerId, now);
    if (!packager.online || !packager.capability) fail("native_packager_offline", 503);
    const verifiedAdmission = admitNativePackager(packager.capability, {
      requestVersion: 1,
      trigger: "user-action",
      tenantId: packager.capability.tenantId,
      ownerSubjectRef: packager.capability.ownerSubjectRef,
      roomId: admission.roomId,
      programId: admission.programId,
      programEpoch: admission.programEpoch,
      resourceRef: admission.resourceRef,
      requestedRenditions: admission.renditions?.length,
      allowHardwareAcceleration: admission.videoEncoder !== "libx264",
    }, now);
    if (JSON.stringify(verifiedAdmission) !== JSON.stringify(admission)) {
      fail("native_packager_admission_mismatch", 409);
    }
    const currentForPackager = this.#byPackager.get(packagerId);
    const currentForProgram = this.#byProgram.get(admission.programId);
    if ((currentForPackager && ACTIVE_STATES.has(currentForPackager.state))
      || (currentForProgram && ACTIVE_STATES.has(currentForProgram.state))) {
      fail("native_packager_assignment_conflict", 409);
    }
    const assignmentId = this.#idFactory();
    if (!ASSIGNMENT.test(assignmentId || "") || this.#assignments.has(assignmentId)) {
      fail("invalid_native_packager_assignment_identifier", 500);
    }
    const record = {
      assignmentId,
      packagerId,
      ownerPrincipal,
      roomId: admission.roomId,
      programId: admission.programId,
      programEpoch: admission.programEpoch,
      resourceRef: admission.resourceRef,
      leaseId: lease.leaseId,
      fencingRevision: lease.fencingRevision,
      admission: Object.freeze(admission),
      state: "preparing",
      reasonCode: "AWAITING_AGENT",
      createdAt: now,
      updatedAt: now,
      expiresAt: lease.expiresAt,
    };
    this.#assignments.set(assignmentId, record);
    this.#byPackager.set(packagerId, record);
    this.#byProgram.set(admission.programId, record);
    return Object.freeze({ snapshot: snapshot(record), command: this.#prepareCommand(record) });
  }

  acknowledge(packagerId, value, now = Date.now()) {
    const message = clone(value, "invalid_native_packager_assignment_status");
    exact(message, new Set([
      "version", "type", "assignmentId", "programEpoch", "fencingRevision", "state", "reasonCode", "observedAt",
    ]), "invalid_native_packager_assignment_status");
    if (message.version !== 1 || message.type !== "assignment-status"
      || !ASSIGNMENT.test(message.assignmentId || "") || !REPORTED_STATES.has(message.state)
      || !REASON.test(message.reasonCode || "") || !Number.isSafeInteger(message.programEpoch)
      || message.programEpoch < 1 || !Number.isSafeInteger(message.fencingRevision)
      || message.fencingRevision < 1 || !Number.isSafeInteger(message.observedAt)
      || Math.abs(now - message.observedAt) > 30_000) fail("invalid_native_packager_assignment_status");
    const record = this.#assignments.get(message.assignmentId);
    if (!record || record.packagerId !== packagerId || record.programEpoch !== message.programEpoch
      || record.fencingRevision !== message.fencingRevision) fail("stale_native_packager_assignment", 409);
    if (record.expiresAt <= now && message.state !== "stopped" && message.state !== "failed") {
      fail("expired_native_packager_assignment", 409);
    }
    const allowed = {
      preparing: new Set(["ready", "failed"]),
      ready: new Set(["ready", "starting", "draining", "failed"]),
      starting: new Set(["starting", "running", "degraded", "draining", "failed"]),
      running: new Set(["running", "degraded", "draining", "failed"]),
      degraded: new Set(["running", "degraded", "draining", "failed"]),
      draining: new Set(["draining", "stopped", "failed"]),
      stopped: new Set(["stopped"]),
      failed: new Set(["failed"]),
    }[record.state];
    if (!allowed?.has(message.state)) fail("invalid_native_packager_assignment_transition", 409);
    record.state = message.state;
    record.reasonCode = message.reasonCode;
    record.updatedAt = now;
    if (!ACTIVE_STATES.has(record.state)) this.#releaseIndexes(record);
    return snapshot(record);
  }

  stop(ownerPrincipal, packagerId, assignmentId, reasonCode = "OWNER_STOP", now = Date.now()) {
    if (!PACKAGER.test(packagerId || "") || !ASSIGNMENT.test(assignmentId || "")
      || !REASON.test(reasonCode || "")) {
      fail("invalid_native_packager_assignment_stop");
    }
    const record = this.#assignments.get(assignmentId);
    if (!record || record.ownerPrincipal !== ownerPrincipal || record.packagerId !== packagerId) {
      fail("native_packager_assignment_not_found", 404);
    }
    if (!ACTIVE_STATES.has(record.state)) return Object.freeze({ snapshot: snapshot(record), command: null });
    record.state = "draining";
    record.reasonCode = reasonCode;
    record.updatedAt = now;
    return Object.freeze({
      snapshot: snapshot(record),
      command: Object.freeze({
        version: 1,
        type: "assignment-stop",
        assignmentId: record.assignmentId,
        programEpoch: record.programEpoch,
        fencingRevision: record.fencingRevision,
        reasonCode,
      }),
    });
  }

  failPackager(packagerId, reasonCode = "CONTROL_DISCONNECTED", now = Date.now()) {
    const record = this.#byPackager.get(packagerId);
    if (!record || !ACTIVE_STATES.has(record.state)) return null;
    record.state = "failed";
    record.reasonCode = reasonCode;
    record.updatedAt = now;
    this.#releaseIndexes(record);
    return snapshot(record);
  }

  activeForProgram(programId) {
    const record = this.#byProgram.get(programId);
    return record && ACTIVE_STATES.has(record.state) ? snapshot(record) : null;
  }

  activeForPackager(packagerId) {
    const record = this.#byPackager.get(packagerId);
    return record && ACTIVE_STATES.has(record.state) ? snapshot(record) : null;
  }

  list(ownerPrincipal) {
    return Object.freeze([...this.#assignments.values()]
      .filter((record) => record.ownerPrincipal === ownerPrincipal)
      .map(snapshot)
      .sort((left, right) => right.updatedAt - left.updatedAt));
  }

  prune(now = Date.now(), onExpired = () => {}) {
    if (typeof onExpired !== "function") fail("invalid_native_packager_assignment_prune", 500);
    for (const record of this.#assignments.values()) {
      if (ACTIVE_STATES.has(record.state) && record.expiresAt <= now) {
        record.state = "failed";
        record.reasonCode = "LEASE_EXPIRED";
        record.updatedAt = now;
        this.#releaseIndexes(record);
        onExpired(record.ownerPrincipal, snapshot(record));
      }
      if (!ACTIVE_STATES.has(record.state) && record.updatedAt <= now - 60 * 60_000) {
        this.#assignments.delete(record.assignmentId);
      }
    }
  }

  #prepareCommand(record) {
    return Object.freeze({
      version: 1,
      type: "assignment-prepare",
      assignmentId: record.assignmentId,
      roomId: record.roomId,
      programId: record.programId,
      programEpoch: record.programEpoch,
      leaseId: record.leaseId,
      fencingRevision: record.fencingRevision,
      resourceRef: record.resourceRef,
      profile: Object.freeze({
        profileId: record.admission.profileId,
        maximumQueueFrames: record.admission.maximumQueueFrames,
        keyframeIntervalSeconds: record.admission.keyframeIntervalSeconds,
        renditions: Object.freeze(record.admission.renditions.map((rendition) => Object.freeze({
          id: rendition.id,
          width: rendition.width,
          height: rendition.height,
          framesPerSecond: rendition.framesPerSecond,
          videoBitsPerSecond: rendition.videoBitsPerSecond,
          audioBitsPerSecond: rendition.audioBitsPerSecond,
        }))),
      }),
      expiresAt: record.expiresAt,
    });
  }

  #releaseIndexes(record) {
    if (this.#byPackager.get(record.packagerId) === record) this.#byPackager.delete(record.packagerId);
    if (this.#byProgram.get(record.programId) === record) this.#byProgram.delete(record.programId);
  }
}
