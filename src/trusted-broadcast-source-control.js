import crypto from "node:crypto";
import { broadcastDeviceRef } from "./broadcast-identifiers.js";
import { parseTrustedSourceSignal, TrustedSourceNegotiation } from "./trusted-broadcast-source-signal.js";

const REF = prefix => new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`);
const positive = value => Number.isSafeInteger(value) && value > 0;
const STATUS_FIELDS = ["version", "type", "sourceLeaseId", "leaseRevision", "consentId", "assignmentId", "fencingRevision", "state", "expiresAt", "observedAt"];
export function validTrustedSourceStatus(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === STATUS_FIELDS.length && Object.keys(value).every(key => STATUS_FIELDS.includes(key))
    && value.version === 1 && value.type === "trusted-source-status"
    && ["sourceLeaseId", "consentId", "assignmentId"].every((key, i) => typeof value[key] === "string" && REF(["sls", "cns", "asn"][i]).test(value[key]))
    && positive(value.leaseRevision) && value.leaseRevision <= 1024 && positive(value.fencingRevision)
    && positive(value.expiresAt) && positive(value.observedAt)
    && ["receiver-prepared", "failed", "stopped"].includes(value.state);
}

export class TrustedSourceControlError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new TrustedSourceControlError(code); };

// Owns metadata leases, never media or keys. prepare is an internal operation:
// its consent ID must resolve through the existing current source authority.
export class TrustedBroadcastSourceControl {
  #grants; #assignments; #control; #send; #clock; #id; #members; #sendSignal; #sendPublisher;
  #records = new Map(); #byConsent = new Map(); #lastNow = 0; #closed = false;
  #ackRates = new WeakMap();
  #signalRates = new WeakMap();
  constructor({ grants, assignments, control, send, members, sendSignal, sendPublisher, clock = Date.now,
    sourceLeaseId = () => `sls_${crypto.randomBytes(18).toString("base64url")}` }) {
    if (typeof grants?.forPackager !== "function" || typeof assignments?.sourceContext !== "function"
      || typeof control?.sourceConnection !== "function" || typeof control?.socketFor !== "function"
      || [send, clock, sourceLeaseId, members, sendSignal, sendPublisher].some(port => typeof port !== "function")) fail("invalid_source_control_ports");
    this.#grants = grants; this.#assignments = assignments; this.#control = control;
    this.#send = send; this.#clock = clock; this.#id = sourceLeaseId;
    this.#members = members; this.#sendSignal = sendSignal; this.#sendPublisher = sendPublisher;
  }

  prepare(consentId, socket) {
    const now = this.#now(), connection = this.#control.sourceConnection(socket);
    if (!connection || this.#control.socketFor(connection.id) !== socket) fail("source_control_connection_required");
    if (!connection.sourceControlV1) fail("source_control_upgrade_required");
    const scope = this.#grants.forPackager(consentId, connection.id, connection.deviceRef);
    if (!scope) fail("source_control_consent_unavailable");
    const parent = this.#parent(scope, now);
    this.#pruneHistory(now);
    const old = this.#byConsent.get(consentId);
    if (old) {
      if (!this.#current(old, now) || old.socket !== socket) fail("source_control_lease_terminal");
      return old.lease; // No implicit retry, ACK, revision or lifetime extension.
    }
    if (this.#records.size >= 1024 || [...this.#records.values()].filter(r => r.packagerId === connection.id).length >= 80) {
      fail("source_control_capacity");
    }
    const sourceLeaseId = this.#id();
    if (typeof sourceLeaseId !== "string" || !REF("sls").test(sourceLeaseId) || this.#records.has(sourceLeaseId)) fail("invalid_source_control_identifier");
    const lease = Object.freeze({ version: 1, type: "trusted-source-lease", sourceLeaseId, revision: 1,
      consent: scope.consent, assignmentId: parent.assignmentId, writerLeaseId: scope.leaseId,
      fencingRevision: scope.fencingRevision, publisherPeerId: scope.publisherPeerId,
      publisherDeviceRef: scope.publisherDeviceRef, publicationId: scope.publicationId, publicationEpoch: scope.publicationEpoch,
      codec: ["microphone", "screen-audio"].includes(scope.consent.sourceKind) ? "audio/opus" : "video/vp8",
      frameEnvelope: "codec-prefix-v1", issuedAt: now, expiresAt: Math.min(now + 4000, scope.consent.expiresAt, parent.expiresAt) });
    if (lease.expiresAt <= now + 1000) fail("source_control_parent_expiring");
    const record = { lease, socket, packagerId: connection.id, active: true, acknowledged: false,
      prepared: false, publisherRevision: 0, negotiation: new TrustedSourceNegotiation() };
    this.#records.set(sourceLeaseId, record); this.#byConsent.set(consentId, record);
    if (!this.#deliver(record, { version: 1, type: "trusted-source-prepare", lease })) {
      this.#stop(record, "CONTROL_DELIVERY_FAILED"); fail("source_control_delivery_failed");
    }
    return lease;
  }

  // The socket is the actual authenticated native connection, not an ID from
  // the message. A late valid source status never tears down its parent program.
  acknowledge(socket, message) {
    if (!validTrustedSourceStatus(message)) fail("invalid_trusted_source_status");
    const now = this.#now(), record = this.#records.get(message.sourceLeaseId);
    const connection = this.#control.sourceConnection(socket);
    if (!record || record.socket !== socket || connection?.id !== record.packagerId
      || this.#control.socketFor(record.packagerId) !== socket) return false;
    let rate = this.#ackRates.get(socket);
    if (!rate || rate.expiresAt <= now) { rate = { count: 0, expiresAt: now + 10000 }; this.#ackRates.set(socket, rate); }
    if (++rate.count > 1024) return false;
    const lease = record.lease;
    if (message.consentId !== lease.consent.consentId || message.assignmentId !== lease.assignmentId
      || message.fencingRevision !== lease.fencingRevision) return false;
    if (!this.#current(record, now)) return false;
    // Ignore delayed duplicate acknowledgements for an earlier renewal. They
    // must neither authorize the current revision nor revoke a newer receiver.
    if (message.leaseRevision < lease.revision) return false;
    if (message.leaseRevision !== lease.revision || message.expiresAt !== lease.expiresAt
      || message.observedAt < lease.issuedAt - 1000 || message.observedAt > now + 1000
      || message.state !== "receiver-prepared") { this.#stop(record, "SOURCE_RECEIVER_FAILED"); return false; }
    record.acknowledged = true;
    record.prepared = true;
    if (record.publisherRevision !== lease.revision) {
      if (!this.#publisher(record, { version: 1, type: "trusted-source-publisher-lease", lease })) {
        this.#stop(record, "PUBLISHER_DELIVERY_FAILED"); return false;
      }
      record.publisherRevision = lease.revision;
    }
    return true;
  }

  publisherSignal(peer, value) { return this.#signal(peer, value, true); }
  packagerSignal(socket, value) { return this.#signal(socket, value, false); }

  #signal(actor, value, publisher) {
    const message = parseTrustedSourceSignal(value, publisher ? "trusted-source-publisher-signal" : "trusted-source-packager-signal");
    const now = this.#now(), record = this.#records.get(message.sourceLeaseId);
    if (!record || !record.active || !record.prepared) return false;
    if (!this.#control.sourceConnection(record.socket)?.sourceSignalV1) {
      if (record.signalingStarted) this.#stop(record, "SOURCE_SIGNAL_CAPABILITY_LOST");
      return false;
    }
    const lease = record.lease;
    if (message.consentId !== lease.consent.consentId || message.assignmentId !== lease.assignmentId
      || message.fencingRevision !== lease.fencingRevision) return false;
    const peers = this.#members(lease.consent.roomId);
    const peer = peers.find(member => member.id === lease.publisherPeerId);
    if (!peer || peer.authenticated !== true || peer.machine === true
      || broadcastDeviceRef(peer.deviceFingerprint) !== lease.publisherDeviceRef) return false;
    const socket = publisher ? actor?.socket : actor;
    if (publisher ? peer !== actor : record.socket !== socket || this.#control.socketFor(record.packagerId) !== socket) return false;
    let rate = this.#signalRates.get(socket);
    if (!rate || rate.expiresAt <= now) { rate = { count: 0, expiresAt: now + 10000 }; this.#signalRates.set(socket, rate); }
    if (++rate.count > 512 || !this.#current(record, now) || !record.negotiation.accept(message, now)) return false;
    record.signalingStarted = true;
    const target = publisher ? record.socket : peer.socket;
    const forwarded = Object.freeze({ ...message,
      type: publisher ? "trusted-source-peer-signal" : "trusted-source-agent-signal",
      ...(publisher ? { publisherPeerId: peer.id } : { packagerId: record.packagerId, packagerDeviceRef: lease.consent.granteeDeviceRef }),
    });
    try { if (this.#sendSignal(target, forwarded) === true) return true; } catch { /* bounded terminal source failure */ }
    this.#stop(record, "SOURCE_SIGNAL_DELIVERY_FAILED");
    return false;
  }

  tick() {
    const now = this.#now(); this.#pruneHistory(now);
    for (const record of this.#records.values()) {
      if (!this.#current(record, now)) continue;
      const previous = record.lease;
      if (!record.acknowledged || now < previous.issuedAt + 1000) continue;
      const scope = this.#grants.forPackager(previous.consent.consentId, record.packagerId, previous.consent.granteeDeviceRef);
      if (!scope) { this.#stop(record, "SOURCE_AUTHORITY_LOST"); continue; }
      const parent = this.#parent(scope, now);
      const expiresAt = Math.min(now + 4000, previous.consent.expiresAt, parent.expiresAt);
      if (expiresAt <= previous.expiresAt) continue;
      if (previous.revision >= 1024) { this.#stop(record, "SOURCE_REVISION_LIMIT"); continue; }
      record.lease = Object.freeze({ ...previous, revision: previous.revision + 1, issuedAt: now, expiresAt });
      record.acknowledged = false;
      if (!this.#deliver(record, { version: 1, type: "trusted-source-prepare", lease: record.lease })) this.#stop(record, "CONTROL_DELIVERY_FAILED");
    }
  }

  destroy() {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#records.values()) this.#stop(record, "SOURCE_CONTROL_CLOSED");
    this.#records.clear(); this.#byConsent.clear();
  }
  #parent(scope, now) {
    const parent = this.#assignments.sourceContext(scope.consent.granteePackagerRef, now);
    if (!parent || parent.roomId !== scope.consent.roomId || parent.programId !== scope.consent.programId
      || parent.programEpoch !== scope.consent.programEpoch || parent.leaseId !== scope.leaseId
      || parent.fencingRevision !== scope.fencingRevision) fail("source_control_assignment_unavailable");
    return parent;
  }
  #current(record, now) {
    if (!record.active) return false;
    const lease = record.lease;
    try {
      if (lease.expiresAt <= now || this.#control.socketFor(record.packagerId) !== record.socket
        || !this.#control.sourceConnection(record.socket)?.sourceControlV1
        || record.signalingStarted && !this.#control.sourceConnection(record.socket)?.sourceSignalV1) throw new Error();
      const scope = this.#grants.forPackager(lease.consent.consentId, record.packagerId, lease.consent.granteeDeviceRef);
      if (!scope || scope.consent !== lease.consent || scope.publisherPeerId !== lease.publisherPeerId
        || scope.publisherDeviceRef !== lease.publisherDeviceRef || scope.publicationId !== lease.publicationId
        || scope.publicationEpoch !== lease.publicationEpoch) throw new Error();
      const parent = this.#parent(scope, now);
      if (parent.assignmentId !== lease.assignmentId || parent.expiresAt < lease.expiresAt) throw new Error();
      return true;
    } catch { this.#stop(record, "SOURCE_AUTHORITY_LOST"); return false; }
  }
  #stop(record, reasonCode) {
    if (!record.active) return;
    record.active = false;
    const lease = record.lease;
    const message = { version: 1, type: "trusted-source-stop", sourceLeaseId: lease.sourceLeaseId,
      leaseRevision: lease.revision, consentId: lease.consent.consentId, assignmentId: lease.assignmentId,
      fencingRevision: lease.fencingRevision, expiresAt: lease.expiresAt, reasonCode };
    this.#deliver(record, message);
    this.#publisher(record, { ...message, type: "trusted-source-publisher-stop" });
  }
  #publisher(record, message) {
    const lease = record.lease;
    try {
      const peer = this.#members(lease.consent.roomId).find(value => value.id === lease.publisherPeerId);
      if (!peer || peer.authenticated !== true || peer.machine === true
        || broadcastDeviceRef(peer.deviceFingerprint) !== lease.publisherDeviceRef) return false;
      return this.#sendPublisher(peer.socket, message) === true;
    } catch { return false; }
  }
  #deliver(record, message) {
    try {
      if (this.#control.socketFor(record.packagerId) !== record.socket) return false;
      return this.#send(record.socket, message) === true;
    } catch { return false; }
  }
  #pruneHistory(now) {
    for (const [id, record] of this.#records) if (record.lease.consent.expiresAt <= now) {
      this.#stop(record, "SOURCE_CONSENT_EXPIRED");
      this.#records.delete(id); this.#byConsent.delete(record.lease.consent.consentId);
    }
  }
  #now() {
    if (this.#closed) fail("source_control_closed");
    const now = this.#clock();
    if (!positive(now) || now > Number.MAX_SAFE_INTEGER - 600000 || now < this.#lastNow) {
      this.destroy(); fail("source_control_clock_invalid");
    }
    this.#lastNow = now; return now;
  }
}
