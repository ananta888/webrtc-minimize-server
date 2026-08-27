import assert from "node:assert/strict";
import test from "node:test";

import { RoomFullError, RoomRegistry } from "../src/room-registry.js";

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
