import crypto from "node:crypto";

import { PEER_ID_PATTERN, ProtocolError, TRACK_ID_PATTERN } from "./protocol.js";

export const MEDIA_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MEDIA_AGENT_REQUEST_PATTERN = /^[a-f0-9]{32}$/;
export const MAX_MEDIA_AGENT_CONSENTS = 3;
const AUTH_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PROOF_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const ENROLLMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JWK_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,47}$/;
const BATTERY_STATES = new Set(["critical", "limited", "mains", "unknown"]);
const NETWORK_STATES = new Set(["constrained", "normal", "fast", "unknown"]);
const MEDIA_LAYERS = new Set(["audio", "single", "low", "medium", "high"]);
const MEDIA_RIDS = new Set(["", "q", "h", "f"]);
const FEDERATION_LINK_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function exact(value, fields) {
  return Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function parse(raw, maximum = 96 * 1024) {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (bytes > maximum) throw new ProtocolError("agent_message_too_large");
  let value;
  try { value = JSON.parse(raw.toString()); } catch { throw new ProtocolError("invalid_agent_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_agent_message");
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`invalid_agent_${name}`);
  }
  return value;
}

function agentPublicKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exact(value, new Set(["kty", "crv", "x", "y", "ext"]))
    || value.kty !== "EC" || value.crv !== "P-256" || value.ext !== true
    || !JWK_COORDINATE_PATTERN.test(value.x || "") || !JWK_COORDINATE_PATTERN.test(value.y || "")) {
    throw new ProtocolError("invalid_agent_public_key");
  }
  return Object.freeze({ kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true });
}

function description(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exact(value, new Set(["type", "sdp"]))
    || !new Set(["offer", "answer"]).has(value.type)
    || typeof value.sdp !== "string" || value.sdp.length > 80_000) {
    throw new ProtocolError("invalid_agent_description");
  }
  return Object.freeze({ type: value.type, sdp: value.sdp });
}

function candidate(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !new Set([
      "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment",
    ]).has(key))
    || typeof value.candidate !== "string" || value.candidate.length > 4_096) {
    throw new ProtocolError("invalid_agent_candidate");
  }
  return Object.freeze({
    candidate: value.candidate,
    ...(typeof value.sdpMid === "string" ? { sdpMid: value.sdpMid.slice(0, 64) } : {}),
    ...(Number.isSafeInteger(value.sdpMLineIndex) ? { sdpMLineIndex: value.sdpMLineIndex } : {}),
    ...(typeof value.usernameFragment === "string"
      ? { usernameFragment: value.usernameFragment.slice(0, 256) } : {}),
  });
}

function signal(value, recipientField) {
  const allowed = new Set([
    "type", recipientField, "roomId", "routeEpoch", "description", "candidate", "negotiationSequence",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ProtocolError("unknown_agent_signal_field");
  const recipient = String(value[recipientField] || "");
  if (recipientField === "peerId" && !PEER_ID_PATTERN.test(recipient)) throw new ProtocolError("invalid_agent_peer");
  if (recipientField === "agentId" && !MEDIA_AGENT_ID_PATTERN.test(recipient)) throw new ProtocolError("invalid_agent_id");
  if (!ROOM_ID_PATTERN.test(value.roomId || "")) throw new ProtocolError("invalid_agent_room");
  const hasDescription = Object.hasOwn(value, "description");
  const hasCandidate = Object.hasOwn(value, "candidate");
  if (hasDescription === hasCandidate) throw new ProtocolError("invalid_agent_signal");
  const parsedDescription = hasDescription ? description(value.description) : null;
  const hasNegotiationSequence = Object.hasOwn(value, "negotiationSequence");
  const nativeOffer = recipientField === "peerId" && parsedDescription?.type === "offer";
  if (hasNegotiationSequence !== nativeOffer) {
    throw new ProtocolError("invalid_agent_negotiation_sequence");
  }
  return Object.freeze({
    type: "media-agent-signal",
    [recipientField]: recipient,
    roomId: value.roomId,
    routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
    ...(hasDescription ? { description: parsedDescription } : { candidate: candidate(value.candidate) }),
    ...(nativeOffer ? {
      negotiationSequence: integer(
        value.negotiationSequence,
        "negotiation_sequence",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    } : {}),
  });
}

function federationSignal(value) {
  const allowed = new Set([
    "version", "type", "recipientAgentId", "roomId", "routeEpoch", "linkId", "description", "candidate",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ProtocolError("unknown_federation_signal_field");
  }
  const hasDescription = Object.hasOwn(value, "description");
  const hasCandidate = Object.hasOwn(value, "candidate");
  if (value.version !== 1 || hasDescription === hasCandidate
    || !MEDIA_AGENT_ID_PATTERN.test(value.recipientAgentId || "")
    || !ROOM_ID_PATTERN.test(value.roomId || "") || !FEDERATION_LINK_PATTERN.test(value.linkId || "")) {
    throw new ProtocolError("invalid_federation_signal");
  }
  return Object.freeze({
    version: 1,
    type: "federation-signal",
    recipientAgentId: value.recipientAgentId,
    roomId: value.roomId,
    routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
    linkId: value.linkId,
    ...(hasDescription ? { description: description(value.description) } : { candidate: candidate(value.candidate) }),
  });
}

export function parseBrowserMediaAgentMessage(raw) {
  const value = parse(raw);
  if (value.type === "media-agent-consent-set") {
    if (!exact(value, new Set(["version", "type", "agentIds", "automaticTakeover"]))) {
      throw new ProtocolError("unknown_media_agent_consent_set_field");
    }
    if (value.version !== 1 || !Array.isArray(value.agentIds)
      || value.agentIds.length > MAX_MEDIA_AGENT_CONSENTS
      || typeof value.automaticTakeover !== "boolean"
      || value.agentIds.some((agentId) => (
        typeof agentId !== "string" || !MEDIA_AGENT_ID_PATTERN.test(agentId)
      ))
      || new Set(value.agentIds).size !== value.agentIds.length) {
      throw new ProtocolError("invalid_media_agent_consent_set");
    }
    return Object.freeze({
      version: 1,
      type: value.type,
      agentIds: Object.freeze([...value.agentIds].sort()),
      automaticTakeover: value.automaticTakeover,
    });
  }
  if (value.type === "media-agent-consent") {
    if (!exact(value, new Set(["type", "enabled", "agentId", "automaticTakeover"]))) {
      throw new ProtocolError("unknown_media_agent_consent_field");
    }
    if (typeof value.enabled !== "boolean" || typeof value.automaticTakeover !== "boolean") {
      throw new ProtocolError("invalid_media_agent_consent");
    }
    if (!MEDIA_AGENT_ID_PATTERN.test(value.agentId || "")) throw new ProtocolError("invalid_agent_id");
    return Object.freeze({
      type: value.type,
      enabled: value.enabled,
      agentId: value.agentId,
      automaticTakeover: value.automaticTakeover,
    });
  }
  if (value.type === "media-agent-takeover-response") {
    if (!exact(value, new Set(["type", "requestId", "accepted"]))) {
      throw new ProtocolError("unknown_agent_takeover_field");
    }
    if (!MEDIA_AGENT_REQUEST_PATTERN.test(value.requestId || "") || typeof value.accepted !== "boolean") {
      throw new ProtocolError("invalid_agent_takeover_response");
    }
    return Object.freeze({ type: value.type, requestId: value.requestId, accepted: value.accepted });
  }
  if (value.type === "media-agent-signal") return signal(value, "agentId");
  if (value.type === "media-agent-peer-state") {
    if (!exact(value, new Set(["type", "agentId", "roomId", "routeEpoch", "connected"]))) {
      throw new ProtocolError("unknown_agent_peer_state_field");
    }
    if (!MEDIA_AGENT_ID_PATTERN.test(value.agentId || "") || !ROOM_ID_PATTERN.test(value.roomId || "")
      || typeof value.connected !== "boolean") throw new ProtocolError("invalid_agent_peer_state");
    return Object.freeze({
      type: value.type,
      agentId: value.agentId,
      roomId: value.roomId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      connected: value.connected,
    });
  }
  if (value.type === "media-agent-subscription-intent") {
    if (!exact(value, new Set([
      "version", "type", "agentId", "roomId", "routeEpoch", "publisherPeerId", "publicationId",
      "enabled", "preferredLayer", "maximumLayer",
    ]))) throw new ProtocolError("unknown_agent_subscription_intent_field");
    if (value.version !== 1 || !MEDIA_AGENT_ID_PATTERN.test(value.agentId || "")
      || !ROOM_ID_PATTERN.test(value.roomId || "")
      || !PEER_ID_PATTERN.test(value.publisherPeerId || "")
      || !TRACK_ID_PATTERN.test(value.publicationId || "") || typeof value.enabled !== "boolean"
      || !MEDIA_LAYERS.has(value.preferredLayer) || !MEDIA_LAYERS.has(value.maximumLayer)) {
      throw new ProtocolError("invalid_agent_subscription_intent");
    }
    return Object.freeze({
      version: 1,
      type: value.type,
      agentId: value.agentId,
      roomId: value.roomId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      publisherPeerId: value.publisherPeerId,
      publicationId: value.publicationId,
      enabled: value.enabled,
      preferredLayer: value.preferredLayer,
      maximumLayer: value.maximumLayer,
    });
  }
  if (value.type === "media-agent-subscription-ack") {
    if (!exact(value, new Set([
      "version", "type", "agentId", "roomId", "routeEpoch", "publisherPeerId", "publicationId",
      "revision", "ready",
    ]))) throw new ProtocolError("unknown_agent_subscription_ack_field");
    if (value.version !== 1 || !MEDIA_AGENT_ID_PATTERN.test(value.agentId || "")
      || !ROOM_ID_PATTERN.test(value.roomId || "")
      || !PEER_ID_PATTERN.test(value.publisherPeerId || "")
      || !TRACK_ID_PATTERN.test(value.publicationId || "") || typeof value.ready !== "boolean") {
      throw new ProtocolError("invalid_agent_subscription_ack");
    }
    return Object.freeze({
      version: 1,
      type: value.type,
      agentId: value.agentId,
      roomId: value.roomId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      publisherPeerId: value.publisherPeerId,
      publicationId: value.publicationId,
      revision: integer(value.revision, "subscription_revision", 1, Number.MAX_SAFE_INTEGER),
      ready: value.ready,
    });
  }
  throw new ProtocolError("unknown_message_type");
}

export function parseMediaAgentMessage(raw) {
  const value = parse(raw);
  if (value.type === "enroll") {
    if (!exact(value, new Set([
      "version", "type", "agentId", "enrollmentToken", "timestamp", "publicKey", "proof",
    ]))) throw new ProtocolError("unknown_agent_enrollment_field");
    if (value.version !== 1 || !MEDIA_AGENT_ID_PATTERN.test(value.agentId || "")
      || !ENROLLMENT_TOKEN_PATTERN.test(value.enrollmentToken || "")
      || !SIGNATURE_PROOF_PATTERN.test(value.proof || "")) {
      throw new ProtocolError("invalid_agent_enrollment");
    }
    return Object.freeze({
      version: 1,
      type: "enroll",
      agentId: value.agentId,
      enrollmentToken: value.enrollmentToken,
      timestamp: integer(value.timestamp, "enrollment_timestamp", 0, Number.MAX_SAFE_INTEGER),
      publicKey: agentPublicKey(value.publicKey),
      proof: value.proof,
    });
  }
  if (value.type === "authenticate") {
    const publicKeyAuthentication = value.version === 2;
    const fields = publicKeyAuthentication
      ? new Set(["version", "type", "agentId", "timestamp", "proof"])
      : new Set(["type", "agentId", "timestamp", "proof"]);
    if (!exact(value, fields)) {
      throw new ProtocolError("unknown_agent_auth_field");
    }
    if (!MEDIA_AGENT_ID_PATTERN.test(value.agentId || "")
      || !(publicKeyAuthentication ? SIGNATURE_PROOF_PATTERN : AUTH_PROOF_PATTERN).test(value.proof || "")) {
      throw new ProtocolError("invalid_agent_authentication");
    }
    return Object.freeze({
      ...(publicKeyAuthentication ? { version: 2 } : {}),
      type: value.type,
      agentId: value.agentId,
      timestamp: integer(value.timestamp, "auth_timestamp", 0, Number.MAX_SAFE_INTEGER),
      proof: value.proof,
    });
  }
  if (value.type === "capability") {
    if (!exact(value, new Set([
      "type", "visible", "battery", "network", "capacity", "load", "maxRooms", "maxPeers", "maxTracks",
    ]))) throw new ProtocolError("unknown_agent_capability_field");
    if (typeof value.visible !== "boolean" || !BATTERY_STATES.has(value.battery)
      || !NETWORK_STATES.has(value.network)) throw new ProtocolError("invalid_agent_capability");
    return Object.freeze({
      type: value.type,
      visible: value.visible,
      battery: value.battery,
      network: value.network,
      capacity: integer(value.capacity, "capacity", 0, 100),
      load: integer(value.load, "load", 0, 100),
      maxRooms: integer(value.maxRooms, "max_rooms", 1, 32),
      maxPeers: integer(value.maxPeers, "max_peers", 2, 20),
      maxTracks: integer(value.maxTracks, "max_tracks", 1, 80),
    });
  }
  if (value.type === "heartbeat") {
    if (!exact(value, new Set(["type", "rooms"]))) throw new ProtocolError("unknown_agent_heartbeat_field");
    if (!Array.isArray(value.rooms) || value.rooms.length > 32) throw new ProtocolError("invalid_agent_heartbeat");
    return Object.freeze({
      type: value.type,
      rooms: Object.freeze(value.rooms.map((room) => {
        if (!room || typeof room !== "object" || Array.isArray(room)
          || !exact(room, new Set(["roomId", "routeEpoch"]))) throw new ProtocolError("invalid_agent_heartbeat_room");
        if (!ROOM_ID_PATTERN.test(room.roomId || "")) throw new ProtocolError("invalid_agent_room");
        return Object.freeze({
          roomId: room.roomId,
          routeEpoch: integer(room.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
        });
      })),
    });
  }
  if (value.type === "media-agent-signal") return signal(value, "peerId");
  if (value.type === "federation-signal") return federationSignal(value);
  if (value.type === "federation-state") {
    if (!exact(value, new Set([
      "version", "type", "roomId", "routeEpoch", "linkId", "remoteAgentId", "connected",
    ]))) throw new ProtocolError("unknown_federation_state_field");
    if (value.version !== 1 || !ROOM_ID_PATTERN.test(value.roomId || "")
      || !FEDERATION_LINK_PATTERN.test(value.linkId || "")
      || !MEDIA_AGENT_ID_PATTERN.test(value.remoteAgentId || "") || typeof value.connected !== "boolean") {
      throw new ProtocolError("invalid_federation_state");
    }
    return Object.freeze({
      version: 1,
      type: value.type,
      roomId: value.roomId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      linkId: value.linkId,
      remoteAgentId: value.remoteAgentId,
      connected: value.connected,
    });
  }
  if (value.type === "peer-state") {
    if (!exact(value, new Set(["type", "roomId", "peerId", "routeEpoch", "connected"]))) {
      throw new ProtocolError("unknown_agent_peer_state_field");
    }
    if (!ROOM_ID_PATTERN.test(value.roomId || "") || !PEER_ID_PATTERN.test(value.peerId || "")
      || typeof value.connected !== "boolean") throw new ProtocolError("invalid_agent_peer_state");
    return Object.freeze({
      type: value.type,
      roomId: value.roomId,
      peerId: value.peerId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      connected: value.connected,
    });
  }
  if (value.type === "track-state") {
    if (!exact(value, new Set([
      "version", "type", "roomId", "peerId", "routeEpoch", "publicationId", "layer", "rid", "active",
    ]))) throw new ProtocolError("unknown_agent_track_state_field");
    if (value.version !== 2 || !ROOM_ID_PATTERN.test(value.roomId || "")
      || !PEER_ID_PATTERN.test(value.peerId || "")
      || !TRACK_ID_PATTERN.test(value.publicationId || "") || !MEDIA_LAYERS.has(value.layer)
      || !MEDIA_RIDS.has(value.rid) || typeof value.active !== "boolean") {
      throw new ProtocolError("invalid_agent_track_state");
    }
    return Object.freeze({
      version: 2,
      type: value.type,
      roomId: value.roomId,
      peerId: value.peerId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      publicationId: value.publicationId,
      layer: value.layer,
      rid: value.rid,
      active: value.active,
    });
  }
  if (value.type === "subscription-state") {
    if (!exact(value, new Set([
      "version", "type", "roomId", "routeEpoch", "publisherPeerId", "publicationId",
      "subscriberPeerId", "selectedLayer", "revision", "ready",
    ]))) throw new ProtocolError("unknown_agent_subscription_state_field");
    if (value.version !== 2 || !ROOM_ID_PATTERN.test(value.roomId || "")
      || !PEER_ID_PATTERN.test(value.publisherPeerId || "")
      || !PEER_ID_PATTERN.test(value.subscriberPeerId || "")
      || !TRACK_ID_PATTERN.test(value.publicationId || "") || !MEDIA_LAYERS.has(value.selectedLayer)
      || typeof value.ready !== "boolean") throw new ProtocolError("invalid_agent_subscription_state");
    return Object.freeze({
      version: 2,
      type: value.type,
      roomId: value.roomId,
      routeEpoch: integer(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      publisherPeerId: value.publisherPeerId,
      publicationId: value.publicationId,
      subscriberPeerId: value.subscriberPeerId,
      selectedLayer: value.selectedLayer,
      revision: integer(value.revision, "subscription_revision", 1, Number.MAX_SAFE_INTEGER),
      ready: value.ready,
    });
  }
  if (value.type === "draining") {
    if (!exact(value, new Set(["type", "enabled"]))) throw new ProtocolError("unknown_agent_draining_field");
    if (typeof value.enabled !== "boolean") throw new ProtocolError("invalid_agent_draining");
    return Object.freeze({ type: value.type, enabled: value.enabled });
  }
  throw new ProtocolError("unknown_agent_message_type");
}

export function mediaAgentAuthProof(secret, agentId, nonce, timestamp) {
  return crypto.createHmac("sha256", secret)
    .update(`v1\n${agentId}\n${nonce}\n${timestamp}`)
    .digest("base64url");
}

export function mediaAgentSignatureMessage(agentId, nonce, timestamp) {
  return `v2\n${agentId}\n${nonce}\n${timestamp}`;
}

export function mediaAgentEnrollmentProofMessage(agentId, nonce, timestamp, enrollmentToken, publicKey) {
  return `v1\n${agentId}\n${nonce}\n${timestamp}\n${enrollmentToken}\n${publicKey.x}\n${publicKey.y}`;
}
