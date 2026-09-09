import { oidcPrincipal } from "./broadcast-identifiers.js";
import { normalizeTrustedSourceApproval, TrustedBroadcastSourceError } from "./trusted-broadcast-source-grants.js";

const fail = code => { throw new TrustedBroadcastSourceError(code, 403); };
export function parseTrustedSourceAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) fail("invalid_trusted_source_action");
  if (value.type === "trusted-source-publications" && Object.keys(value).sort().join() === "type,version") {
    return Object.freeze({ version: 1, type: value.type });
  }
  if (value.type === "trusted-source-approve" && Object.keys(value).sort().join() === "approval,type,version") {
    return Object.freeze({ version: 1, type: value.type, approval: normalizeTrustedSourceApproval(value.approval) });
  }
  if (value.type === "trusted-source-revoke" && Object.keys(value).sort().join() === "consentId,type,version"
    && typeof value.consentId === "string" && /^cns_[A-Za-z0-9_-]{16,64}$/.test(value.consentId)) {
    return Object.freeze({ version: 1, type: value.type, consentId: value.consentId });
  }
  fail("invalid_trusted_source_action");
}

/** Internal claims come from the one-time OIDC session ticket, never wire JSON. */
export class TrustedBroadcastSourceActions {
  #ports;
  constructor({ grants, broker, requests, assignments, packagers, members, membershipEpoch }) {
    if ([grants?.approve, grants?.revoke, broker?.prepare, broker?.tick, requests?.resolveForPublisher,
      assignments?.activeForPackager, packagers?.socketFor, packagers?.sourceConnection, members, membershipEpoch]
      .some(port => typeof port !== "function")) throw new TrustedBroadcastSourceError("invalid_trusted_source_action_ports", 500);
    this.#ports = Object.freeze({ grants, broker, requests, assignments, packagers, members, membershipEpoch });
  }
  execute(peer, identity, raw) {
    const message = parseTrustedSourceAction(raw), p = this.#ports;
    if (!identity || !peer || peer.authenticated !== true || peer.machine === true
      || !p.members(peer.roomId).includes(peer) || peer.principal !== oidcPrincipal(identity)) {
      fail("trusted_source_connection_required");
    }
    if (message.type === "trusted-source-publications") {
      const roomEpoch = p.membershipEpoch(peer.roomId);
      if (!Number.isSafeInteger(roomEpoch) || roomEpoch < 1 || !(peer.publications instanceof Map)
        || peer.publications.size > 4 || !Number.isSafeInteger(peer.publicationRevision) || peer.publicationRevision < 0) {
        fail("trusted_source_publications_unavailable");
      }
      return Object.freeze({ version: 1, type: message.type, roomId: peer.roomId, peerId: peer.id,
        roomEpoch, publicationRevision: peer.publicationRevision,
        publications: Object.freeze([...peer.publications.values()].map(value => Object.freeze({
          publicationId: value.publicationId, source: value.source, publicationEpoch: value.publicationEpoch,
        }))) });
    }
    if (message.type === "trusted-source-revoke") {
      p.grants.revoke(identity, peer.deviceFingerprint, message.consentId);
      p.broker.tick();
      return Object.freeze({ version: 1, type: "trusted-source-revoked", consentId: message.consentId });
    }
    const input = message.approval;
    if (input.roomId !== peer.roomId || input.deviceFingerprint !== peer.deviceFingerprint) fail("trusted_source_connection_required");
    const invitation = p.requests.resolveForPublisher(identity, peer.roomId, peer.deviceFingerprint, input.requestId);
    const parent = p.assignments.activeForPackager(invitation.packagerRef);
    const socket = p.packagers.socketFor(invitation.packagerRef);
    if (!parent || parent.inputMode !== "trusted-sframe-v1" || parent.programId !== invitation.programId
      || !socket || p.packagers.sourceConnection(socket)?.sourceSignalV1 !== true) fail("trusted_source_program_unavailable");
    const consent = p.grants.approve(identity, input, peer);
    try { p.broker.prepare(consent.consentId, socket); }
    catch (error) {
      p.grants.revoke(identity, peer.deviceFingerprint, consent.consentId);
      p.broker.tick();
      throw error;
    }
    return Object.freeze({ version: 1, type: "trusted-source-approved", requestId: input.requestId, consent });
  }
}
