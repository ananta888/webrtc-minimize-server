export const ROOM_ROLES = Object.freeze(["owner", "participant"]);
export const HAND_STATES = Object.freeze(["none", "raised"]);
export const HAND_RATE_LIMIT = 6;
export const HAND_RATE_WINDOW_MS = 10_000;

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

export function moderationSnapshot(room, membershipEpoch) {
  if (!room || !Number.isSafeInteger(membershipEpoch) || membershipEpoch < 1) return null;
  return Object.freeze({
    type: "moderation-state",
    membershipEpoch,
    participants: Object.freeze([...room.peers.values()]
      .map((peer) => moderationParticipant(peer, room.creatorPrincipal))
      .sort((left, right) => left.peerId.localeCompare(right.peerId))),
    queue: handQueue(room),
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
  room.updatedAt = now;
  return true;
}

export function clearHand(room, actor, targetPeerId, now) {
  if (!room || room.peers.get(actor.id) !== actor) fail("peer_not_joined");
  if (peerRole(actor, room.creatorPrincipal) !== "owner") fail("moderation_forbidden");
  const target = room.peers.get(targetPeerId);
  if (!target) fail("peer_not_joined");
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_hand_clock");
  target.hand = "none";
  target.handRaisedAt = 0;
  room.updatedAt = now;
  return true;
}
