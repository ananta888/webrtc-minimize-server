import crypto from "node:crypto";

import {
  DEFAULT_ROOM_PARTICIPANTS,
  MAX_ROOM_PARTICIPANTS,
  MIN_ROOM_PARTICIPANTS,
} from "./room-limits.js";

export class RoomFullError extends Error {
  constructor() {
    super("room_full");
    this.code = "room_full";
  }
}

export class RoomAdmissionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class RoomRegistry {
  #rooms = new Map();
  #maxParticipants;
  #idleTtlMs;

  constructor({ maxParticipants = DEFAULT_ROOM_PARTICIPANTS, idleTtlMs = 3_600_000 } = {}) {
    if (
      !Number.isSafeInteger(maxParticipants)
      || maxParticipants < MIN_ROOM_PARTICIPANTS
      || maxParticipants > MAX_ROOM_PARTICIPANTS
    ) {
      throw new RangeError(
        `maxParticipants must be between ${MIN_ROOM_PARTICIPANTS} and ${MAX_ROOM_PARTICIPANTS}`,
      );
    }
    this.#maxParticipants = maxParticipants;
    this.#idleTtlMs = idleTtlMs;
  }

  join(roomId, socket, name, now = Date.now(), admission = {}) {
    const mode = admission.mode || "room";
    const capacity = mode === "pair" ? 2 : this.#maxParticipants;
    if (!new Set(["room", "pair"]).has(mode)) throw new RoomAdmissionError("invalid_room_mode");
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = { peers: new Map(), updatedAt: now, mode, capacity };
      this.#rooms.set(roomId, room);
    }
    if (room.mode !== mode || room.capacity !== capacity) throw new RoomAdmissionError("room_mode_mismatch");
    if (
      mode === "pair" && admission.deviceFingerprint
      && [...room.peers.values()].some((candidate) => candidate.deviceFingerprint === admission.deviceFingerprint)
    ) throw new RoomAdmissionError("duplicate_pair_device");
    if (room.peers.size >= room.capacity) throw new RoomFullError();
    let peerId;
    do peerId = crypto.randomBytes(8).toString("hex"); while (room.peers.has(peerId));
    const existingPeers = [...room.peers.values()].map(({ id, name: peerName }) => ({
      id, name: peerName,
    }));
    const peer = {
      id: peerId,
      roomId,
      name,
      socket,
      joinedAt: now,
      messages: [],
      mode,
      principal: admission.principal || "anonymous",
      deviceFingerprint: admission.deviceFingerprint || "",
      relayConsent: false,
      relayCapability: {
        visible: true,
        battery: "unknown",
        network: "unknown",
        selfCapacity: 50,
        observedCapacity: 50,
        deliveryRatio: 1,
      },
    };
    room.peers.set(peerId, peer);
    room.updatedAt = now;
    return { peer, existingPeers };
  }

  leave(peer, now = Date.now()) {
    const room = this.#rooms.get(peer.roomId);
    if (!room || !room.peers.delete(peer.id)) return [];
    room.updatedAt = now;
    if (room.peers.size === 0) this.#rooms.delete(peer.roomId);
    return [...room.peers.values()];
  }

  recipients(peer) {
    const room = this.#rooms.get(peer.roomId);
    if (!room || room.peers.get(peer.id) !== peer) return [];
    return [...room.peers.values()].filter((candidate) => candidate.id !== peer.id);
  }

  recipient(peer, recipientId) {
    const room = this.#rooms.get(peer.roomId);
    if (!room || room.peers.get(peer.id) !== peer || recipientId === peer.id) return null;
    return room.peers.get(recipientId) || null;
  }

  members(roomId) {
    const room = this.#rooms.get(roomId);
    return room ? [...room.peers.values()] : [];
  }

  setRelayConsent(peer, enabled, now = Date.now()) {
    const room = this.#rooms.get(peer.roomId);
    if (!room || room.peers.get(peer.id) !== peer) throw new RoomAdmissionError("peer_not_joined");
    peer.relayConsent = enabled === true;
    room.updatedAt = now;
    return peer.relayConsent;
  }

  setRelayCapability(peer, capability, now = Date.now()) {
    const room = this.#rooms.get(peer.roomId);
    if (!room || room.peers.get(peer.id) !== peer) throw new RoomAdmissionError("peer_not_joined");
    peer.relayCapability = { ...peer.relayCapability, ...capability };
    room.updatedAt = now;
    return { ...peer.relayCapability };
  }

  updateObservedRelay(peer, observedCapacity, deliveryRatio, now = Date.now()) {
    const room = this.#rooms.get(peer.roomId);
    if (!room || room.peers.get(peer.id) !== peer) throw new RoomAdmissionError("peer_not_joined");
    peer.relayCapability = {
      ...peer.relayCapability,
      observedCapacity: Math.min(peer.relayCapability.observedCapacity, observedCapacity),
      deliveryRatio: Math.min(peer.relayCapability.deliveryRatio, deliveryRatio),
    };
    room.updatedAt = now;
    return { ...peer.relayCapability };
  }

  allowMessage(peer, now = Date.now(), { limit, windowMs = 10_000 }) {
    peer.messages = peer.messages.filter((timestamp) => now - timestamp < windowMs);
    if (peer.messages.length >= limit) return false;
    peer.messages.push(now);
    return true;
  }

  prune(now = Date.now()) {
    let removed = 0;
    for (const [roomId, room] of this.#rooms) {
      if (room.peers.size === 0 && now - room.updatedAt >= this.#idleTtlMs) {
        this.#rooms.delete(roomId);
        removed += 1;
      }
    }
    return removed;
  }

  get roomCount() {
    return this.#rooms.size;
  }

  get participantCount() {
    let result = 0;
    for (const room of this.#rooms.values()) result += room.peers.size;
    return result;
  }
}
