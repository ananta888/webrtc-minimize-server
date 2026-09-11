export const ROOM_ROLES = Object.freeze(["owner", "participant"]);
export const HAND_STATES = Object.freeze(["none", "raised"]);
export const HAND_RATE_LIMIT = 6;
export const HAND_RATE_WINDOW_MS = 10_000;
export const MODERATION_AUDIT_LIMIT = 256;
export const MODERATION_ACTIONS = Object.freeze([
  "hand-raise", "hand-lower", "hand-clear", "peer-remove", "peer-remove-cancel",
  "publication-stop", "presenter-assign", "whiteboard-policy-set",
]);
export const PUBLICATION_SOURCES = Object.freeze(["microphone", "camera", "screen"]);
export const WHITEBOARD_POLICIES = Object.freeze(["open", "presenter-only"]);
export const REMOVE_UNDO_MS = 8_000;

export class RoomModerationError extends Error {
  constructor(code) {
    super(code);
    this.name = "RoomModerationError";
    this.code = code;
  }
}

function fail(code) {
  throw new RoomModerationError(code);
}

export function peerRole(peer, creatorPrincipal) {
  return peer?.principal && peer.principal === creatorPrincipal ? "owner" : "participant";
}

export function moderationParticipant(peer, creatorPrincipal) {
  const raised = peer.hand === "raised" && Number.isSafeInteger(peer.handRaisedAt) && peer.handRaisedAt > 0;
  return Object.freeze({
    peerId: peer.id,
    role: peerRole(peer, creatorPrincipal),
    hand: raised ? "raised" : "none",
    raisedAt: raised ? peer.handRaisedAt : 0,
  });
}

export function handQueue(room) {
  if (!room) return Object.freeze([]);
  return Object.freeze([...room.peers.values()]
    .filter((peer) => peer.hand === "raised" && Number.isSafeInteger(peer.handRaisedAt) && peer.handRaisedAt > 0)
    .sort((left, right) => left.handRaisedAt - right.handRaisedAt || left.id.localeCompare(right.id))
    .map((peer) => peer.id));
}

export function recordAudit(room, { actorPeerId, action, targetPeerId, source = "", now }) {
  if (!room || !Number.isSafeInteger(now) || now < 0) fail("invalid_moderation_audit");
  if (!MODERATION_ACTIONS.includes(action) || !/^[a-f0-9]{16}$/.test(actorPeerId || "")
    || !/^[a-f0-9]{16}$/.test(targetPeerId || "")
    || (action === "publication-stop"
      ? !PUBLICATION_SOURCES.includes(source)
      : (action === "whiteboard-policy-set"
        ? !WHITEBOARD_POLICIES.includes(source)
        : source !== ""))) {
    fail("invalid_moderation_audit");
  }
  room.auditSequence = (room.auditSequence || 0) + 1;
  room.audit = room.audit || [];
  room.audit.push(Object.freeze({
    sequence: room.auditSequence,
    at: now,
    actorPeerId,
    action,
    targetPeerId,
    source,
  }));
  if (room.audit.length > MODERATION_AUDIT_LIMIT) room.audit.splice(0, room.audit.length - MODERATION_AUDIT_LIMIT);
  return true;
}

export function moderationSnapshot(room, membershipEpoch, { audit = false } = {}) {
  if (!room || !Number.isSafeInteger(membershipEpoch) || membershipEpoch < 1) return null;
  const presenterPeerId = room.presenterPeerId && room.peers.has(room.presenterPeerId) ? room.presenterPeerId : "";
  const whiteboardPolicy = WHITEBOARD_POLICIES.includes(room.whiteboardPolicy) ? room.whiteboardPolicy : "open";
  const pending = room.pendingRemove && room.peers.has(room.pendingRemove.targetPeerId)
    ? Object.freeze({ targetPeerId: room.pendingRemove.targetPeerId, expiresAt: room.pendingRemove.expiresAt })
    : null;
  return Object.freeze({
    type: "moderation-state",
    membershipEpoch,
    participants: Object.freeze([...room.peers.values()]
      .map((peer) => moderationParticipant(peer, room.creatorPrincipal))
      .sort((left, right) => left.peerId.localeCompare(right.peerId))),
    queue: handQueue(room),
    presenterPeerId,
    whiteboardPolicy,
    ...(pending ? { pendingRemove: pending } : {}),
    ...(audit ? { audit: Object.freeze([...(room.audit || [])]) } : {}),
  });
}

export function applyHand(room, peer, hand, now) {
  if (!room || room.peers.get(peer.id) !== peer) fail("peer_not_joined");
  if (room.mode === "pair" || peer.machine === true) fail("hand_unavailable");
  if (hand !== "raised" && hand !== "none") fail("invalid_hand_state");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  if (peer.hand === hand) return true;
  peer.handActions = (peer.handActions || []).filter((stamp) => now - stamp < HAND_RATE_WINDOW_MS);
  if (peer.handActions.length >= HAND_RATE_LIMIT) fail("hand_rate_limited");
  peer.handActions.push(now);
  peer.hand = hand;
  peer.handRaisedAt = hand === "raised" ? now : 0;
  room.updatedAt = now;
  recordAudit(room, {
    actorPeerId: peer.id,
    action: hand === "raised" ? "hand-raise" : "hand-lower",
    targetPeerId: peer.id,
    now,
  });
  return true;
}

export function authorizeRemove(room, actor, targetPeerId, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (room.mode === "pair" || actor.machine === true) fail("moderation_unavailable");
  if (peerRole(actor, room.creatorPrincipal) !== "owner") fail("moderation_forbidden");
  if (targetPeerId === actor.id) fail("self_moderation_forbidden");
  const target = room.peers.get(targetPeerId);
  if (!target) fail("peer_not_joined");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  actor.removeActions = (actor.removeActions || []).filter((stamp) => now - stamp < HAND_RATE_WINDOW_MS);
  if (actor.removeActions.length >= HAND_RATE_LIMIT) fail("moderation_rate_limited");
  actor.removeActions.push(now);
  if (room.pendingRemove) fail("moderation_pending_exists");
  room.pendingRemove = Object.freeze({
    targetPeerId,
    actorPeerId: actor.id,
    expiresAt: now + REMOVE_UNDO_MS,
  });
  room.updatedAt = now;
  recordAudit(room, { actorPeerId: actor.id, action: "peer-remove", targetPeerId, now });
  return true;
}

export function cancelRemove(room, actor, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (peerRole(actor, room.creatorPrincipal) !== "owner") fail("moderation_forbidden");
  if (!room.pendingRemove) fail("moderation_pending_missing");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  const targetPeerId = room.pendingRemove.targetPeerId;
  room.pendingRemove = null;
  room.updatedAt = now;
  recordAudit(room, { actorPeerId: actor.id, action: "peer-remove-cancel", targetPeerId, now });
  return true;
}

export function dueRemove(room, now) {
  if (!room?.pendingRemove) return null;
  if (!Number.isSafeInteger(now) || now < room.pendingRemove.expiresAt) return null;
  const targetPeerId = room.pendingRemove.targetPeerId;
  room.pendingRemove = null;
  return targetPeerId;
}

export function clearPendingRemove(room, peerId) {
  if (room?.pendingRemove && (room.pendingRemove.targetPeerId === peerId || room.pendingRemove.actorPeerId === peerId)) {
    room.pendingRemove = null;
  }
}

export function assignPresenter(room, actor, targetPeerId, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (room.mode === "pair" || actor.machine === true) fail("moderation_unavailable");
  if (peerRole(actor, room.creatorPrincipal) !== "owner") fail("moderation_forbidden");
  const target = room.peers.get(targetPeerId);
  if (!target) fail("peer_not_joined");
  if (target.machine === true) fail("moderation_unavailable");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  if (room.presenterPeerId === targetPeerId) return true;
  actor.presenterActions = (actor.presenterActions || []).filter((stamp) => now - stamp < HAND_RATE_WINDOW_MS);
  if (actor.presenterActions.length >= HAND_RATE_LIMIT) fail("moderation_rate_limited");
  actor.presenterActions.push(now);
  room.presenterPeerId = targetPeerId;
  room.updatedAt = now;
  recordAudit(room, { actorPeerId: actor.id, action: "presenter-assign", targetPeerId, now });
  return true;
}

export function fallbackPresenter(room) {
  if (!room) return "";
  if (room.presenterPeerId && room.peers.has(room.presenterPeerId)
    && room.peers.get(room.presenterPeerId).machine !== true) {
    return room.presenterPeerId;
  }
  const owner = [...room.peers.values()].find((peer) => peerRole(peer, room.creatorPrincipal) === "owner" && peer.machine !== true);
  room.presenterPeerId = owner?.id || "";
  return room.presenterPeerId;
}

export function authorizePublicationStop(room, actor, targetPeerId, source, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (room.mode === "pair" || actor.machine === true) fail("moderation_unavailable");
  if (peerRole(actor, room.creatorPrincipal) !== "owner") fail("moderation_forbidden");
  if (targetPeerId === actor.id) fail("self_moderation_forbidden");
  const target = room.peers.get(targetPeerId);
  if (!target) fail("peer_not_joined");
  if (!PUBLICATION_SOURCES.includes(source)) fail("invalid_publication_source");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  actor.stopActions = (actor.stopActions || []).filter((stamp) => now - stamp < HAND_RATE_WINDOW_MS);
  if (actor.stopActions.length >= HAND_RATE_LIMIT) fail("moderation_rate_limited");
  actor.stopActions.push(now);
  room.updatedAt = now;
  recordAudit(room, { actorPeerId: actor.id, action: "publication-stop", targetPeerId, source, now });
  return true;
}

export function clearHand(room, actor, targetPeerId, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (peerRole(actor, room.creatorPrincipal) !== "owner") fail("moderation_forbidden");
  const target = room.peers.get(targetPeerId);
  if (!target) fail("peer_not_joined");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  if (target.hand !== "raised") return true;
  target.hand = "none";
  target.handRaisedAt = 0;
  room.updatedAt = now;
  recordAudit(room, { actorPeerId: actor.id, action: "hand-clear", targetPeerId, now });
  return true;
}

export function setWhiteboardPolicy(room, actor, policy, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (room.mode === "pair" || actor.machine === true) fail("moderation_unavailable");
  const role = peerRole(actor, room.creatorPrincipal);
  const isPresenter = room.presenterPeerId === actor.id;
  if (role !== "owner" && !isPresenter) fail("moderation_forbidden");
  if (!WHITEBOARD_POLICIES.includes(policy)) fail("invalid_whiteboard_policy");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  if (room.whiteboardPolicy === policy) return true;
  actor.whiteboardActions = (actor.whiteboardActions || []).filter((stamp) => now - stamp < HAND_RATE_WINDOW_MS);
  if (actor.whiteboardActions.length >= HAND_RATE_LIMIT) fail("moderation_rate_limited");
  actor.whiteboardActions.push(now);
  room.whiteboardPolicy = policy;
  room.updatedAt = now;
  recordAudit(room, { actorPeerId: actor.id, action: "whiteboard-policy-set", targetPeerId: actor.id, source: policy, now });
  return true;
}

