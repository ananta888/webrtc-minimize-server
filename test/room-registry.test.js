import assert from "node:assert/strict";
import test from "node:test";

import { RoomAdmissionError, RoomFullError, RoomRegistry } from "../src/room-registry.js";

test("RoomRegistry isolates rooms, caps membership and removes empty rooms", () => {
  const registry = new RoomRegistry({ maxParticipants: 2 });
  const first = registry.join("room-alpha", {}, "Ada").peer;
  const secondJoin = registry.join("room-alpha", {}, "Grace");
  const second = secondJoin.peer;
  const thirdRoom = registry.join("room-bravo", {}, "Linus").peer;

  assert.deepEqual(secondJoin.existingPeers, [{ id: first.id, name: "Ada" }]);
  assert.equal(registry.recipient(first, second.id), second);
  assert.equal(registry.recipient(first, thirdRoom.id), null);
  assert.throws(() => registry.join("room-alpha", {}, "Full"), RoomFullError);
  assert.equal(registry.participantCount, 3);

  assert.deepEqual(registry.leave(first), [second]);
  assert.deepEqual(registry.leave(second), []);
  assert.equal(registry.roomCount, 1);
});

test("RoomRegistry rate window is bounded per peer", () => {
  const registry = new RoomRegistry();
  const peer = registry.join("room-alpha", {}, "Ada", 1000).peer;
  assert.equal(registry.allowMessage(peer, 1000, { limit: 2, windowMs: 100 }), true);
  assert.equal(registry.allowMessage(peer, 1050, { limit: 2, windowMs: 100 }), true);
  assert.equal(registry.allowMessage(peer, 1099, { limit: 2, windowMs: 100 }), false);
  assert.equal(registry.allowMessage(peer, 1100, { limit: 2, windowMs: 100 }), true);
});

test("RoomRegistry binds relay consent to current room membership", () => {
  const registry = new RoomRegistry();
  const peer = registry.join("room-alpha", {}, "Ada").peer;
  assert.equal(peer.relayConsent, false);
  assert.equal(registry.setRelayConsent(peer, true), true);
  assert.deepEqual(registry.members("room-alpha"), [peer]);
  registry.leave(peer);
  assert.throws(() => registry.setRelayConsent(peer, false), (error) => (
    error instanceof RoomAdmissionError && error.code === "peer_not_joined"
  ));
});

test("RoomRegistry admits 20 peers per room and keeps rooms isolated", () => {
  const registry = new RoomRegistry();
  const firstRoomPeers = Array.from(
    { length: 20 },
    (_, index) => registry.join("room-twenty", {}, `Peer ${index + 1}`).peer,
  );
  assert.equal(new Set(firstRoomPeers.map((peer) => peer.id)).size, 20);
  assert.throws(() => registry.join("room-twenty", {}, "Peer 21"), RoomFullError);

  const otherRoomPeer = registry.join("room-other", {}, "Independent").peer;
  assert.equal(otherRoomPeer.roomId, "room-other");
  assert.equal(registry.participantCount, 21);
  assert.equal(registry.roomCount, 2);
});

test("RoomRegistry rejects limits outside the supported 2..20 range", () => {
  assert.throws(() => new RoomRegistry({ maxParticipants: 1 }), /between 2 and 20/);
  assert.throws(() => new RoomRegistry({ maxParticipants: 21 }), /between 2 and 20/);
});

test("RoomRegistry imposes no application-level limit on room count", () => {
  const registry = new RoomRegistry();
  const peers = Array.from(
    { length: 250 },
    (_, index) => registry.join(`room-independent-${index}`, {}, `Peer ${index}`).peer,
  );
  assert.equal(registry.roomCount, 250);
  assert.equal(registry.participantCount, 250);
  for (const peer of peers) registry.leave(peer);
  assert.equal(registry.roomCount, 0);
  assert.equal(registry.participantCount, 0);
});

test("RoomRegistry isolates pair mode, caps it at two and rejects a duplicate device", () => {
  const registry = new RoomRegistry();
  const first = registry.join("pair-alpha", {}, "Ada", 1, {
    mode: "pair", principal: "issuer|ada", deviceFingerprint: "device-a",
  }).peer;
  registry.join("pair-alpha", {}, "Grace", 2, {
    mode: "pair", principal: "issuer|grace", deviceFingerprint: "device-b",
  });
  assert.equal(first.mode, "pair");
  assert.throws(() => registry.join("pair-alpha", {}, "Other tab", 3, {
    mode: "pair", principal: "issuer|ada", deviceFingerprint: "device-a",
  }), (error) => error instanceof RoomAdmissionError && error.code === "duplicate_pair_device");
  assert.throws(() => registry.join("pair-alpha", {}, "Third", 3, {
    mode: "pair", principal: "issuer|third", deviceFingerprint: "device-c",
  }), RoomFullError);
  assert.throws(() => registry.join("pair-alpha", {}, "Wrong mode", 3, {
    mode: "room", principal: "issuer|wrong", deviceFingerprint: "device-d",
  }), (error) => error instanceof RoomAdmissionError && error.code === "room_mode_mismatch");
});
