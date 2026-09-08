import crypto from "node:crypto";
import { broadcastDeviceRef, broadcastSubjectRef, broadcastTenantRef, oidcPrincipal } from "./broadcast-identifiers.js";
import { TRACK_ID_PATTERN } from "./protocol.js";
import { TrustedDecryptConsentAuthority } from "./trusted-decrypt-consent-authority.js";

const FIELDS = ["requestVersion", "trigger", "requestId", "roomId", "deviceFingerprint", "publicationId", "expectedPublicationEpoch", "ttlMs"];
const ROOM = /^[a-z0-9][a-z0-9-]{5,47}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const REQUEST = /^bsr_[A-Za-z0-9_-]{24}$/;
const SOURCE = /^src_[A-Za-z0-9_-]{16,64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
export class TrustedBroadcastSourceError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new TrustedBroadcastSourceError(code, status); };
function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== FIELDS.length || Object.keys(input).some(key => !FIELDS.includes(key))
    || !["requestId", "roomId", "deviceFingerprint"].every(key => typeof input[key] === "string")
    || input.requestVersion !== 1 || input.trigger !== "user-action" || !REQUEST.test(input.requestId)
    || !ROOM.test(input.roomId) || !FINGERPRINT.test(input.deviceFingerprint)
    || typeof input.publicationId !== "string" || !TRACK_ID_PATTERN.test(input.publicationId)
    || !positive(input.expectedPublicationEpoch) || !Number.isSafeInteger(input.ttlMs)
    || input.ttlMs < 5000 || input.ttlMs > 600000) fail("invalid_trusted_source_approval", 400);
  return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, input[key]])));
}
function member(peers, bound) {
  return peers.find(peer => peer.id === bound.id && peer.principal === bound.principal
    && peer.deviceFingerprint === bound.fingerprint && peer.authenticated === true && peer.machine !== true);
}

// Internal control-plane authority only. Identity arguments must come from the
// OIDC verifier; the ports read current server-owned state, never request JSON.
// No HTTP, capture, key transport, media or automatic source acceptance here.
export class TrustedBroadcastSourceGrants {
  #ports;
  #authority = new TrustedDecryptConsentAuthority();
  #records = new Map();
  #byRequest = new Map();
  #rates = new Map();
  #lastNow = 0;
  #closed = false;
  constructor({ members, publication, membershipEpoch, invitation, writer, packager, clock = Date.now,
    sourceId = () => `src_${crypto.randomBytes(18).toString("base64url")}` }) {
    const ports = { members, publication, membershipEpoch, invitation, writer, packager, clock, sourceId };
    if (Object.values(ports).some(port => typeof port !== "function")) fail("invalid_trusted_source_ports", 500);
    this.#ports = Object.freeze(ports);
  }

  approve(identity, raw) {
    const input = normalize(raw), now = this.#now(), principal = oidcPrincipal(identity);
    this.#prune(now); this.#rate(principal, now);
    const old = this.#byRequest.get(input.requestId);
    if (old) {
      if (old.publisher.principal !== principal) fail("trusted_source_unavailable", 404);
      if (old.input !== JSON.stringify(input)
        || !this.#current(old, now)) fail("stale_trusted_source_approval", 409);
      return old.consent; // Never refresh key, consent or writer lifetime on replay.
    }
    const invite = this.#ports.invitation(identity, input.roomId, input.deviceFingerprint, input.requestId);
    if (invite.publisher.principal !== principal || invite.publisher.fingerprint !== input.deviceFingerprint
      || invite.roomId !== input.roomId || invite.expiresAt <= now) fail("trusted_source_invitation_unavailable", 404);
    const record = { ...invite, publisherIdentity: Object.freeze({ issuer: identity.issuer, subject: identity.subject }),
      publicationId: input.publicationId, publicationEpoch: input.expectedPublicationEpoch,
      input: JSON.stringify(input), createdAt: now, active: true };
    const checked = this.#check(record, now);
    const records = [...this.#records.values()];
    if (records.length >= 1024 || records.filter(value => value.programId === record.programId).length >= 80
      || records.filter(value => value.programId === record.programId && value.publisher.id === record.publisher.id).length >= 4) {
      fail("trusted_source_quota", 429);
    }
    if (records.some(value => value.active && value.programId === record.programId
      && value.publisher.id === record.publisher.id && value.publicationId === record.publicationId)) {
      fail("trusted_source_already_consented", 409);
    }
    const sourceId = this.#ports.sourceId();
    if (typeof sourceId !== "string" || !SOURCE.test(sourceId)
      || records.some(value => value.consent.sourceId === sourceId)) fail("invalid_trusted_source_identifier", 500);
    const { writer, capability, epoch, generation } = checked;
    const tenantId = broadcastTenantRef(identity.issuer), subjectRef = broadcastSubjectRef(identity);
    const consent = this.#authority.issue({ requestVersion: 1, requestId: input.requestId, trigger: "user-action",
      tenantId, roomId: record.roomId, roomEpoch: epoch, programId: record.programId, programEpoch: record.programEpoch,
      sourceId, sourceKind: record.sourceKind, purpose: "broadcast-program", granteePackagerRef: record.packagerRef,
      granteeDeviceRef: capability.deviceRef, ttlMs: input.ttlMs }, {
      identity: { authenticated: true, tenantId, subjectRef },
      membership: { active: true, tenantId, roomId: record.roomId, roomEpoch: epoch, subjectRef,
        deviceRef: broadcastDeviceRef(record.publisher.fingerprint), sources: [{ sourceId, sourceKind: record.sourceKind, active: true }] },
      packager: { registered: true, authorized: true, packagerRef: record.packagerRef, deviceRef: capability.deviceRef },
      lease: { active: true, roomId: record.roomId, programId: record.programId, programEpoch: record.programEpoch,
        holderRef: record.packagerRef, deviceRef: capability.deviceRef, expiresAt: writer.expiresAt },
      // This one source is admitted by the current owner's explicit invitation,
      // not by substituting the existing clear-program composite's source list.
      program: { tenantId, roomId: record.roomId, programId: record.programId, programEpoch: record.programEpoch,
        state: writer.state, sourceIds: [sourceId] },
    }, now);
    Object.assign(record, { consent, roomEpoch: epoch, leaseId: writer.leaseId,
      generation, retainUntil: Math.max(invite.expiresAt, consent.expiresAt) });
    this.#records.set(consent.consentId, record); this.#byRequest.set(input.requestId, record);
    return consent;
  }

  // An already authenticated agent connection supplies these identity arguments.
  // This scope is a prepare prerequisite, not an ACK or proof of active media.
  forPackager(consentId, packagerRef, deviceRef) {
    const now = this.#now(), record = this.#records.get(consentId);
    if (!record || record.packagerRef !== packagerRef || record.consent.granteeDeviceRef !== deviceRef
      || !this.#current(record, now)) return null;
    return Object.freeze({ consent: record.consent, publisherPeerId: record.publisher.id,
      publisherDeviceRef: broadcastDeviceRef(record.publisher.fingerprint), publicationId: record.publicationId,
      publicationEpoch: record.publicationEpoch, leaseId: record.leaseId, fencingRevision: record.fencingRevision });
  }

  revoke(identity, deviceFingerprint, consentId) {
    const now = this.#now(), record = this.#records.get(consentId);
    if (!record || record.publisher.principal !== oidcPrincipal(identity)
      || record.publisher.fingerprint !== deviceFingerprint) fail("trusted_source_unavailable", 404);
    this.#invalidate(record, "user-revoked", now);
    return record.consent;
  }

  prune() { const now = this.#now(); return this.#prune(now); }
  auditEvents() { return this.#authority.auditEvents(); }
  destroy() {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#records.values()) this.#invalidate(record, "destroyed", this.#lastNow);
    this.#records.clear(); this.#byRequest.clear(); this.#rates.clear();
  }

  #check(record, now) {
    const peers = this.#ports.members(record.roomId);
    const publisher = member(peers, record.publisher), owner = member(peers, record.owner);
    const publication = this.#ports.publication(record.publisher.id, record.publicationId, record.roomId);
    const epoch = this.#ports.membershipEpoch(record.roomId);
    if (!publisher || !owner || !positive(epoch) || !publication || publication.publicationEpoch !== record.publicationEpoch
      || publication.source !== record.sourceKind || publication.publicationId !== record.publicationId) {
      fail("trusted_source_publication_unavailable", 409);
    }
    const writer = this.#ports.writer(record.ownerIdentity, owner, record.programId, now);
    if (["programRevision", "programEpoch", "packagerRef", "fencingRevision"].some(key => writer[key] !== record[key])
      || writer.tenantId !== broadcastTenantRef(record.publisherIdentity.issuer)
      || writer.ownerSubjectRef !== broadcastSubjectRef(record.ownerIdentity)
      || !/^lea_[A-Za-z0-9_-]{16,64}$/.test(writer.leaseId || "") || !positive(writer.expiresAt)
      || writer.expiresAt <= now || !["live", "degraded"].includes(writer.state)) fail("trusted_source_writer_unavailable", 409);
    const candidate = this.#ports.packager(record.owner.principal, record.packagerRef, record.roomId, now), capability = candidate?.capability;
    if (candidate?.id !== record.packagerRef || candidate.online !== true || !capability
      || !candidate.generation || typeof candidate.generation !== "object" || !Object.isFrozen(candidate.generation)
      || capability.agentId !== record.packagerRef || capability.tenantId !== writer.tenantId
      || capability.ownerSubjectRef !== writer.ownerSubjectRef || !/^dev_[A-Za-z0-9_-]{16,64}$/.test(capability.deviceRef || "")
      || !positive(capability.expiresAt) || capability.expiresAt <= now
      || !capability.consentedRoomIds?.includes(record.roomId) || !["healthy", "degraded"].includes(capability.health)) {
      fail("trusted_source_packager_unavailable", 409);
    }
    if (record.consent && (record.roomEpoch !== epoch || record.leaseId !== writer.leaseId || record.generation !== candidate.generation
      || record.consent.granteeDeviceRef !== capability.deviceRef || record.consent.expiresAt > writer.expiresAt)) {
      fail("stale_trusted_source_scope", 409);
    }
    return { writer, capability, epoch, generation: candidate.generation };
  }
  #current(record, now) {
    if (!record.active) return false;
    if (record.consent.expiresAt <= now) { this.#invalidate(record, "expired", now); return false; }
    try { this.#check(record, now); return true; }
    catch { this.#invalidate(record, "lease-lost", now); return false; }
  }
  #invalidate(record, reason, now) {
    if (!record.active) return;
    record.active = false;
    record.consent = this.#authority.revoke(record.consent.consentId, record.consent.grantorSubjectRef, reason, now);
  }
  #prune(now) {
    const revoked = [];
    for (const [id, record] of this.#records) {
      const wasActive = record.active;
      this.#current(record, now);
      if (wasActive && !record.active) revoked.push(id);
      if (record.retainUntil <= now) { this.#records.delete(id); this.#byRequest.delete(record.requestId); }
    }
    for (const [id, rate] of this.#rates) if (rate.expiresAt <= now) this.#rates.delete(id);
    return Object.freeze(revoked);
  }
  #now() {
    if (this.#closed) fail("trusted_sources_closed", 503);
    const now = this.#ports.clock();
    if (!positive(now) || now > Number.MAX_SAFE_INTEGER - 600000 || now < this.#lastNow) {
      this.destroy(); fail("invalid_trusted_source_clock", 503);
    }
    this.#lastNow = now;
    return now;
  }
  #rate(principal, now) {
    let rate = this.#rates.get(principal);
    if (!rate) {
      if (this.#rates.size >= 2048) fail("trusted_source_rate", 429);
      rate = { count: 0, expiresAt: now + 60000 }; this.#rates.set(principal, rate);
    }
    if (++rate.count > 60) fail("trusted_source_rate", 429);
  }
}
