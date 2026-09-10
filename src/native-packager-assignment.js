import crypto from "node:crypto";
import { nativeOutputRequestFields } from "./native-source-video-output.js";
import { NativePackagerScopedResourceBudget } from "./native-packager-scoped-resources.js";
import { NativeEncoderTimeBudget } from "./native-encoder-time-budget.js";

import {
  admitNativePackager,
  supportsNativeAssignmentV2,
  supportsNativeAssignmentV3,
  supportsNativeSourceSignalV1,
  supportsNativeSourceAudioV3,
} from "./native-packager-policy.js";

const PACKAGER = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const ASSIGNMENT = /^asn_[A-Za-z0-9_-]{16,64}$/;
const LEASE = /^lea_[A-Za-z0-9_-]{16,64}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const PEER = /^[a-f0-9]{16}$/;
const ACTIVE_STATES = new Set(["preparing", "ready", "starting", "running", "degraded", "draining"]);
const RENEWABLE_STATES = new Set(["preparing", "ready", "starting", "running", "degraded"]);
const REPORTED_STATES = new Set(["ready", "starting", "running", "degraded", "draining", "stopped", "failed"]);
const ASSIGNMENT_LEASE_MS = 60_000;

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

function normalizeIceServers(value, sourceProgram = false) {
  if (!Array.isArray(value) || value.length < (sourceProgram ? 0 : 1) || value.length > 24) {
    fail("invalid_native_packager_ice_configuration", 500);
  }
  return Object.freeze(value.map((entry) => {
    const fields = new Set(["urls", "username", "credential", "credentialType"]);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((field) => !fields.has(field))) {
      fail("invalid_native_packager_ice_configuration", 500);
    }
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    if (urls.length < 1 || urls.length > 8 || urls.some((url) => typeof url !== "string"
      || url.length < 6 || url.length > 2048 || !/^(?:stun|stuns|turn|turns):[^\s]+$/i.test(url))) {
      fail("invalid_native_packager_ice_configuration", 500);
    }
    const usesTurn = urls.some((url) => /^turns?:/i.test(url));
    if (sourceProgram && (urls.some(url => !/^(?:stuns?|turns?):[!-~]+$/.test(url))
      || usesTurn && urls.some(url => !/^turns?:/.test(url)))) {
      fail("invalid_native_packager_ice_configuration", 500);
    }
    const username = entry.username;
    const credential = entry.credential;
    if (usesTurn !== (typeof username === "string" && username.length >= 1 && username.length <= 512
      && typeof credential === "string" && credential.length >= 1 && credential.length <= 512
      && entry.credentialType === "password")) {
      fail("invalid_native_packager_ice_configuration", 500);
    }
    if (!usesTurn && (username !== undefined || credential !== undefined || entry.credentialType !== undefined)) {
      fail("invalid_native_packager_ice_configuration", 500);
    }
    return Object.freeze({
      urls: Object.freeze([...urls]),
      ...(usesTurn ? { username, credential, credentialType: "password" } : {}),
    });
  }));
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
    ...(record.assignmentProtocolVersion >= 4 ? { inputMode: "trusted-sframe-v1" } : {}),
  });
}

export class NativePackagerAssignmentRegistry {
  #control;
  #assignments = new Map();
  #byPackager = new Map();
  #byProgram = new Map();
  #idFactory;
  #iceServersForPackager;
  #sourceProgramMembership;
  #programLeaseDeadline;
  #resourceBudget;
  #encoderTimeBudget;

  constructor({
    controlRegistry,
    idFactory = () => `asn_${crypto.randomBytes(18).toString("base64url")}`,
    iceServersForPackager = () => [],
    sourceProgramMembership = () => 0,
    programLeaseDeadline = () => Number.MAX_SAFE_INTEGER,
    resourceLimits,
    scopedResourceLimits,
    encoderMinutesLimits,
  } = {}) {
    if (!controlRegistry || typeof controlRegistry.candidate !== "function"
      || typeof idFactory !== "function" || typeof iceServersForPackager !== "function"
      || typeof sourceProgramMembership !== "function" || typeof programLeaseDeadline !== "function") {
      fail("invalid_native_packager_assignment_configuration", 500);
    }
    this.#control = controlRegistry;
    this.#idFactory = idFactory;
    this.#iceServersForPackager = iceServersForPackager;
    this.#sourceProgramMembership = sourceProgramMembership;
    this.#programLeaseDeadline = programLeaseDeadline;
    this.#resourceBudget = new NativePackagerScopedResourceBudget(resourceLimits, scopedResourceLimits);
    this.#encoderTimeBudget = new NativeEncoderTimeBudget(encoderMinutesLimits);
  }

  admit(ownerPrincipal, packagerId, request, now = Date.now()) {
    const { admission, tenantId } = this.#candidateAdmission(ownerPrincipal, packagerId, request, now);
    this.#assertResources(admission, tenantId, ownerPrincipal, now);
    this.#assertEncoderTime(admission, tenantId, ownerPrincipal, now, now + ASSIGNMENT_LEASE_MS);
    return admission;
  }

  #candidateAdmission(ownerPrincipal, packagerId, request, now) {
    const packager = this.#control.candidate(ownerPrincipal, packagerId, now);
    if (!packager.online || !packager.capability) fail("native_packager_offline", 503);
    return { admission: admitNativePackager(packager.capability, request, now), tenantId: packager.capability.tenantId };
  }

  // Server-only replacement preview. This neither reserves capacity nor skips
  // the full occupancy check in prepare, even if the old writer is draining.
  previewReplacement(ownerPrincipal, packagerId, request, previousAssignmentId, controllerPeerId, now = Date.now()) {
    const previous = this.#assignments.get(previousAssignmentId);
    if (!previous || previous.ownerPrincipal !== ownerPrincipal || previous.packagerId === packagerId
      || !["running", "degraded", "draining", "stopped"].includes(previous.state) || previous.expiresAt <= now
      || request?.programId !== previous.programId || request?.roomId !== previous.roomId
      || request?.tenantId !== previous.tenantId
      || ![previous.programEpoch, previous.programEpoch + 1].includes(request?.programEpoch)) {
      fail("stale_native_packager_replacement", 409);
    }
    if (this.activeForPackager(packagerId)) fail("native_packager_assignment_conflict", 409);
    const { admission, tenantId } = this.#candidateAdmission(ownerPrincipal, packagerId, request, now);
    if (previous.assignmentProtocolVersion >= 4) {
      if (controllerPeerId !== previous.controllerPeerId) fail("stale_native_packager_replacement", 409);
      this.#sourceAuthority(ownerPrincipal, packagerId, admission.roomId, controllerPeerId, now, !!admission.audioOutput);
    } else if (controllerPeerId !== previous.publisherPeerId) fail("stale_native_packager_replacement", 409);
    this.#assertResources(admission, tenantId, ownerPrincipal, now, previous);
    this.#assertEncoderTime(admission, tenantId, ownerPrincipal, now, now + ASSIGNMENT_LEASE_MS);
    return admission;
  }

  prepare(ownerPrincipal, packagerId, admissionValue, leaseValue, publisherPeerId, now = Date.now()) {
    return this.#prepare(ownerPrincipal, packagerId, admissionValue, leaseValue, publisherPeerId, false, now);
  }

  prepareSourceProgram(ownerPrincipal, packagerId, admissionValue, leaseValue, controllerPeerId, now = Date.now()) {
    return this.#prepare(ownerPrincipal, packagerId, admissionValue, leaseValue, controllerPeerId, true, now);
  }

  admitSourceProgram(ownerPrincipal, packagerId, request, controllerPeerId, now = Date.now()) {
    const admission = this.admit(ownerPrincipal, packagerId, request, now);
    this.#sourceAuthority(ownerPrincipal, packagerId, admission.roomId, controllerPeerId, now, !!admission.audioOutput);
    if (this.activeForPackager(packagerId)) fail("native_packager_assignment_conflict", 409);
    return admission;
  }

  #sourceAuthority(ownerPrincipal, packagerId, roomId, controllerPeerId, now, outputRequired = false) {
    if (typeof this.#control.sourceContext !== "function") fail("native_source_program_unavailable", 409);
    const current = this.#control.sourceContext(ownerPrincipal, packagerId, roomId, now);
    const capability = current?.capability;
    const roomEpoch = this.#sourceProgramMembership(ownerPrincipal, roomId, controllerPeerId);
    if (current?.id !== packagerId || current.online !== true || !current.generation
      || typeof current.generation !== "object" || !Object.isFrozen(current.generation)
      || !supportsNativeSourceSignalV1(capability) || capability.agentId !== packagerId
      || outputRequired && !supportsNativeSourceAudioV3(capability)
      || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(capability.tenantId || "")
      || !/^dev_[A-Za-z0-9_-]{16,64}$/.test(capability.deviceRef || "")
      || !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= now
      || !["healthy", "degraded"].includes(capability.health)
      || !capability.consentedRoomIds?.includes(roomId)
      || !Number.isSafeInteger(roomEpoch) || roomEpoch < 1) fail("native_source_program_unavailable", 409);
    return { sourceGeneration: current.generation, sourceContext: Object.freeze({
      schema: "ananta.trusted-source-program-context.v1", tenantId: capability.tenantId,
      granteeDeviceRef: capability.deviceRef, roomEpoch, frameEnvelope: "codec-prefix-v1",
    }) };
  }

  #sourceCurrent(record, now) {
    const current = this.#sourceAuthority(record.ownerPrincipal, record.packagerId, record.roomId, record.controllerPeerId, now, !!record.admission.audioOutput);
    if (current.sourceGeneration !== record.sourceGeneration
      || JSON.stringify(current.sourceContext) !== JSON.stringify(record.sourceContext)) {
      fail("stale_native_source_program", 409);
    }
  }

  #prepare(ownerPrincipal, packagerId, admissionValue, leaseValue, peerId, sourceProgram, now) {
    const admission = clone(admissionValue);
    if (!sourceProgram && admission.admissionVersion !== 1) fail("invalid_native_packager_assignment");
    const lease = clone(leaseValue);
    exact(lease, new Set(["leaseId", "fencingRevision", "expiresAt"]));
    if (!PACKAGER.test(packagerId || "") || !PEER.test(peerId || "")
      || !LEASE.test(lease.leaseId || "")
      || !Number.isSafeInteger(lease.fencingRevision) || lease.fencingRevision < 1
      || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + 120_000) {
      fail("invalid_native_packager_assignment");
    }
    const packager = this.#control.candidate(ownerPrincipal, packagerId, now);
    if (!packager.online || !packager.capability) fail("native_packager_offline", 503);
    const verifiedAdmission = admitNativePackager(packager.capability, {
      ...nativeOutputRequestFields(admission.audioOutput, admission.videoOutput),
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
    const sourceAuthority = sourceProgram
      ? this.#sourceAuthority(ownerPrincipal, packagerId, admission.roomId, peerId, now, !!admission.audioOutput) : null;
    if (sourceAuthority && sourceAuthority.sourceContext.tenantId !== packager.capability.tenantId) {
      fail("native_source_program_unavailable", 409);
    }
    const programDeadline = this.#programLeaseDeadline({ tenantId: packager.capability.tenantId,
      programId: admission.programId, programEpoch: admission.programEpoch }, now);
    if (!Number.isSafeInteger(programDeadline) || programDeadline <= now) fail("native_packager_program_unavailable", 409);
    lease.expiresAt = Math.min(lease.expiresAt, programDeadline);
    const currentForPackager = this.#byPackager.get(packagerId);
    const currentForProgram = this.#byProgram.get(admission.programId);
    if ((currentForPackager && ACTIVE_STATES.has(currentForPackager.state))
      || (currentForProgram && ACTIVE_STATES.has(currentForProgram.state))) {
      fail("native_packager_assignment_conflict", 409);
    }
    this.#assertResources(verifiedAdmission, packager.capability.tenantId, ownerPrincipal, now);
    this.#assertEncoderTime(verifiedAdmission, packager.capability.tenantId, ownerPrincipal, now, lease.expiresAt);
    const assignmentId = this.#idFactory();
    if (!ASSIGNMENT.test(assignmentId || "") || this.#assignments.has(assignmentId)) {
      fail("invalid_native_packager_assignment_identifier", 500);
    }
    const record = {
      assignmentId,
      packagerId,
      ownerPrincipal,
      tenantId: packager.capability.tenantId,
      publisherPeerId: sourceProgram ? null : peerId,
      controllerPeerId: sourceProgram ? peerId : null,
      ...sourceAuthority,
      roomId: admission.roomId,
      programId: admission.programId,
      programEpoch: admission.programEpoch,
      resourceRef: admission.resourceRef,
      leaseId: lease.leaseId,
      fencingRevision: lease.fencingRevision,
      admission: verifiedAdmission,
      assignmentProtocolVersion: sourceProgram ? (admission.audioOutput ? 5 : 4) : supportsNativeAssignmentV3(packager.capability.agentVersion)
        ? 3 : (supportsNativeAssignmentV2(packager.capability.agentVersion) ? 2 : 1),
      iceServers: sourceProgram || supportsNativeAssignmentV3(packager.capability.agentVersion)
        ? normalizeIceServers(this.#iceServersForPackager(packagerId, now), sourceProgram) : null,
      state: "preparing",
      reasonCode: "AWAITING_AGENT",
      createdAt: now,
      updatedAt: now,
      expiresAt: lease.expiresAt,
      encoderBudgetUntil: lease.expiresAt,
    };
    this.#assertResources(verifiedAdmission, packager.capability.tenantId, ownerPrincipal, now);
    // Reentrant ICE/ID ports may have admitted another writer since the first checks.
    if (this.activeForPackager(packagerId) || this.activeForProgram(admission.programId) || this.#assignments.has(assignmentId)) {
      fail("native_packager_assignment_conflict", 409);
    }
    if (!this.#encoderTimeBudget.reserve({ tenantId: record.tenantId, ownerPrincipal }, verifiedAdmission.renditions.length,
      now, record.expiresAt, now)) fail("broadcast_temporarily_unavailable", 429);
    this.#assignments.set(assignmentId, record);
    this.#byPackager.set(packagerId, record);
    this.#byProgram.set(admission.programId, record);
    return Object.freeze({ snapshot: snapshot(record), command: this.#prepareCommand(record) });
  }

  #occupiedResources(now, replacement = null) {
    if (!Number.isSafeInteger(now) || now < 1) fail("broadcast_temporarily_unavailable", 429);
    return [...this.#assignments.values()]
      .filter(record => record !== replacement
        && (ACTIVE_STATES.has(record.state) || record.state === "failed" && record.expiresAt > now))
      .map(record => ({ tenantId: record.tenantId, ownerPrincipal: record.ownerPrincipal, admission: record.admission }));
  }

  resourceCounts(now = Date.now()) {
    return this.#resourceBudget.snapshot(this.#occupiedResources(now));
  }
  encoderTimeCounts(now = Date.now()) { return this.#encoderTimeBudget.snapshot(now); }
  #assertEncoderTime(admission, tenantId, ownerPrincipal, now, until) {
    if (!this.#encoderTimeBudget.allows({ tenantId, ownerPrincipal }, admission.renditions.length, now, until, now)) {
      fail("broadcast_temporarily_unavailable", 429);
    }
  }

  #assertResources(admission, tenantId, ownerPrincipal, now, replacement = null) {
    if (!this.#resourceBudget.allows({ admission, tenantId, ownerPrincipal }, this.#occupiedResources(now, replacement))) {
      fail("broadcast_temporarily_unavailable", 429);
    }
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
    if (record.assignmentProtocolVersion >= 4 && ["ready", "starting", "running", "degraded"].includes(message.state)) {
      this.#sourceCurrent(record, now);
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

  readyOutput(packagerId, value, now = Date.now()) {
    if (value?.state !== "running" || value?.reasonCode !== "OUTPUT_READY") {
      fail("invalid_native_packager_output_status");
    }
    return this.#acknowledgedOutput(packagerId, value, now);
  }

  unavailableOutput(packagerId, value, now = Date.now()) {
    if (!["degraded", "draining", "stopped", "failed"].includes(value?.state)) {
      fail("invalid_native_packager_output_status");
    }
    return this.#acknowledgedOutput(packagerId, value, now);
  }

  #acknowledgedOutput(packagerId, value, now) {
    if (!PACKAGER.test(packagerId || "") || !ASSIGNMENT.test(value?.assignmentId || "")
      || !REASON.test(value?.reasonCode || "") || !Number.isSafeInteger(now)
      || !Number.isSafeInteger(value?.programEpoch) || !Number.isSafeInteger(value?.fencingRevision)) {
      fail("invalid_native_packager_output_status");
    }
    const record = this.#assignments.get(value.assignmentId);
    if (!record || record.packagerId !== packagerId || record.state !== value.state
      || record.reasonCode !== value.reasonCode || record.updatedAt > now
      || record.programEpoch !== value.programEpoch
      || record.fencingRevision !== value.fencingRevision) {
      fail("stale_native_packager_output_status", 409);
    }
    if (record.expiresAt <= now) {
      // A verified terminal receipt may complete after its old lease ended.
      // Forward its lifecycle status, but expose no output mutation binding.
      if (["stopped", "failed"].includes(value.state)) return null;
      fail("stale_native_packager_output_status", 409);
    }
    if (record.assignmentProtocolVersion >= 4 && ["running", "degraded"].includes(value.state)) this.#sourceCurrent(record, now);
    return Object.freeze({
      resourceRef: record.resourceRef,
      programId: record.programId,
      packagerId: record.packagerId,
      fencingRevision: record.fencingRevision,
    });
  }

  statusTarget(packagerId, value, now = Date.now()) {
    if (!PACKAGER.test(packagerId || "") || !ASSIGNMENT.test(value?.assignmentId || "")
      || !Number.isSafeInteger(value?.programEpoch) || !Number.isSafeInteger(value?.fencingRevision)) {
      fail("invalid_native_packager_status_target");
    }
    const record = this.#assignments.get(value.assignmentId);
    if (!record || record.packagerId !== packagerId || record.programEpoch !== value.programEpoch
      || record.fencingRevision !== value.fencingRevision || record.updatedAt > now) {
      fail("stale_native_packager_status_target", 409);
    }
    return Object.freeze({
      publisherPeerId: record.controllerPeerId || record.publisherPeerId,
      assignment: snapshot(record),
    });
  }

  renew(packagerId, now = Date.now()) {
    if (!PACKAGER.test(packagerId || "") || !Number.isSafeInteger(now)) {
      fail("invalid_native_packager_assignment_renewal");
    }
    const record = this.#byPackager.get(packagerId);
    if (!record || !RENEWABLE_STATES.has(record.state) || record.expiresAt <= now) return null;
    const previousExpiry = record.expiresAt;
    const programDeadline = this.#programLeaseDeadline({ tenantId: record.tenantId,
      programId: record.programId, programEpoch: record.programEpoch }, now);
    if (!Number.isSafeInteger(programDeadline) || programDeadline <= now || !RENEWABLE_STATES.has(record.state)) return null;
    if (record.assignmentProtocolVersion >= 4) this.#sourceCurrent(record, now);
    if (this.#byPackager.get(packagerId) !== record || !RENEWABLE_STATES.has(record.state) || record.expiresAt !== previousExpiry) return null;
    const expiresAt = Math.min(now + ASSIGNMENT_LEASE_MS, programDeadline);
    if (!this.#encoderTimeBudget.reserve({ tenantId: record.tenantId, ownerPrincipal: record.ownerPrincipal }, record.admission.renditions.length,
      record.encoderBudgetUntil, Math.max(record.encoderBudgetUntil, expiresAt), now)) return null;
    record.encoderBudgetUntil = Math.max(record.encoderBudgetUntil, expiresAt);
    record.expiresAt = expiresAt;
    record.updatedAt = now;
    return Object.freeze({
      snapshot: snapshot(record),
      resourceRef: record.resourceRef,
      command: Object.freeze({
        version: 1,
        type: "assignment-renew",
        assignmentId: record.assignmentId,
        programEpoch: record.programEpoch,
        fencingRevision: record.fencingRevision,
        expiresAt: record.expiresAt,
      }),
    });
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
    if (record.state === "draining") return Object.freeze({ snapshot: snapshot(record), command: null });
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

  handoffStopStatus(ownerPrincipal, assignmentId) {
    const record = this.#assignments.get(assignmentId);
    if (!record || record.ownerPrincipal !== ownerPrincipal) fail("native_packager_assignment_not_found", 404);
    return record.state === "stopped" ? "stopped" : record.state === "failed" ? "failed" : "waiting";
  }

  activeForPackager(packagerId) {
    const record = this.#byPackager.get(packagerId);
    return record && ACTIVE_STATES.has(record.state) ? snapshot(record) : null;
  }

  // Internal source receiver parent, not an additional assignment or authority.
  sourceContext(packagerId, now = Date.now()) {
    const record = this.#byPackager.get(packagerId);
    if (!record || !["running", "degraded"].includes(record.state) || record.expiresAt <= now) return null;
    if (record.assignmentProtocolVersion >= 4) {
      try { this.#sourceCurrent(record, now); } catch { return null; }
    }
    return Object.freeze({ ...snapshot(record), leaseId: record.leaseId });
  }

  authorizeBrowserSignal(peer, message, now = Date.now()) {
    const record = this.#signalRecord(message, now);
    if (!peer || record.ownerPrincipal !== peer.principal || record.roomId !== peer.roomId
      || record.publisherPeerId !== peer.id || record.packagerId !== message.packagerId
      || record.programId !== message.programId) {
      fail("stale_native_packager_signal", 409);
    }
    return snapshot(record);
  }

  authorizePackagerSignal(packagerId, message, now = Date.now()) {
    const record = this.#signalRecord(message, now);
    if (record.packagerId !== packagerId) fail("stale_native_packager_signal", 409);
    return Object.freeze({ ...snapshot(record), publisherPeerId: record.publisherPeerId });
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
        if (record.state !== "draining" || record.reasonCode !== "LEASE_EXPIRED") {
          record.state = "draining";
          record.reasonCode = "LEASE_EXPIRED";
          record.updatedAt = now;
          onExpired(record.ownerPrincipal, snapshot(record), Object.freeze({
            version: 1,
            type: "assignment-stop",
            assignmentId: record.assignmentId,
            programEpoch: record.programEpoch,
            fencingRevision: record.fencingRevision,
            reasonCode: "LEASE_EXPIRED",
          }));
        } else if (record.updatedAt <= now - 30_000) {
          record.state = "failed";
          record.updatedAt = now;
          this.#releaseIndexes(record);
        }
      }
      if (!ACTIVE_STATES.has(record.state) && record.updatedAt <= now - 60 * 60_000) {
        this.#assignments.delete(record.assignmentId);
      }
    }
  }

  #prepareCommand(record) {
    const profile = {
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
    };
    if (record.assignmentProtocolVersion >= 2) {
      profile.videoEncoder = record.admission.videoEncoder;
      profile.softwareFallback = record.admission.softwareFallback;
    }
    return Object.freeze({
      version: record.assignmentProtocolVersion,
      type: "assignment-prepare",
      assignmentId: record.assignmentId,
      roomId: record.roomId,
      programId: record.programId,
      programEpoch: record.programEpoch,
      leaseId: record.leaseId,
      fencingRevision: record.fencingRevision,
      resourceRef: record.resourceRef,
      ...(record.assignmentProtocolVersion >= 4 ? { inputMode: "trusted-sframe-v1", sourceContext: record.sourceContext }
        : { publisherPeerId: record.publisherPeerId }),
      ...(record.assignmentProtocolVersion === 5 ? { audioOutput: record.admission.audioOutput } : {}),
      profile: Object.freeze(profile),
      ...(record.assignmentProtocolVersion >= 3 ? { iceServers: record.iceServers } : {}),
      expiresAt: record.expiresAt,
    });
  }

  #releaseIndexes(record) {
    if (this.#byPackager.get(record.packagerId) === record) this.#byPackager.delete(record.packagerId);
    if (this.#byProgram.get(record.programId) === record) this.#byProgram.delete(record.programId);
  }

  #signalRecord(message, now) {
    const record = this.#assignments.get(message?.assignmentId);
    if (!record || record.assignmentProtocolVersion >= 4 || !ACTIVE_STATES.has(record.state) || record.expiresAt <= now
      || record.programEpoch !== message.programEpoch
      || record.fencingRevision !== message.fencingRevision) {
      fail("stale_native_packager_signal", 409);
    }
    return record;
  }
}
