import crypto from "node:crypto";

export class RoomFullError extends Error {
  constructor() {
    super("room_full");
    this.code = "room_full";
  }
}

export class RoomRegistry {
  #rooms = new Map();
  #maxParticipants;
  #idleTtlMs;

  constructor({ maxParticipants = 4, idleTtlMs = 3_600_000 } = {}) {
    this.#maxParticipants = maxParticipants;
    this.#idleTtlMs = idleTtlMs;
  }

  join(roomId, socket, name, now = Date.now()) {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = { peers: new Map(), updatedAt: now };
      this.#rooms.set(roomId, room);
    }
    if (room.peers.size >= this.#maxParticipants) throw new RoomFullError();
    let peerId;
    do peerId = crypto.randomBytes(8).toString("hex"); while (room.peers.has(peerId));
    const existingPeers = [...room.peers.values()].map(({ id, name: peerName }) => ({
      id, name: peerName,
    }));
    const peer = { id: peerId, roomId, name, socket, joinedAt: now, messages: [] };
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
