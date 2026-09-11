import assert from "node:assert/strict";
import test from "node:test";

import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { RoomAdmissionError, RoomRegistry } from "../src/room-registry.js";
import { RoomModerationError, fallbackPresenter, peerRole } from "../src/room-moderation.js";

const errorCode = (code) => (error) => error instanceof RoomModerationError && error.code === code;
const protocolErrorCode = (code) => (error) => error instanceof ProtocolError && error.code === code;

test("protocol parses valid presenter-assign message and rejects malformed fields", () => {
  const valid = parseClientMessage(JSON.stringify({
    type: "presenter-assign",
    targetPeerId: "0123456789abcdef",
  }));
  assert.equal(valid.type, "presenter-assign");
  assert.equal(valid.targetPeerId, "0123456789abcdef");

  // Rejects invalid targetPeerId
  assert.throws(() => parseClientMessage(JSON.stringify({
    type: "presenter-assign",
    targetPeerId: "short",
  })), protocolErrorCode("invalid_recipient"));

  // Rejects unknown extra fields
  assert.throws(() => parseClientMessage(JSON.stringify({
    type: "presenter-assign",
    targetPeerId: "0123456789abcdef",
    extra: "forbidden",
  })), protocolErrorCode("unknown_message_field"));
});

test("presenter assignment is strictly owner-controlled and rejects non-owners", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("pres-room", {}, "Owner", 1, { principal: "owner-id" }).peer;
  const guest1 = registry.join("pres-room", {}, "Guest1", 2, { principal: "guest1-id" }).peer;
  const guest2 = registry.join("pres-room", {}, "Guest2", 3, { principal: "guest2-id" }).peer;

  // Initial presenter is the owner
  assert.equal(registry.moderationSnapshot("pres-room", 1).presenterPeerId, owner.id);

  // Guest cannot assign presenter
  assert.throws(() => registry.assignPresenter(guest1, guest2.id, 10), errorCode("moderation_forbidden"));

  // Owner assigns guest1
  assert.equal(registry.assignPresenter(owner, guest1.id, 20), true);
  assert.equal(registry.moderationSnapshot("pres-room", 1).presenterPeerId, guest1.id);

  // Owner reassigns to guest2
  assert.equal(registry.assignPresenter(owner, guest2.id, 30), true);
  assert.equal(registry.moderationSnapshot("pres-room", 1).presenterPeerId, guest2.id);
});

test("presenter handoff falls back to owner on presenter departure", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("pres-room", {}, "Owner", 1, { principal: "owner-id" }).peer;
  const guest = registry.join("pres-room", {}, "Guest", 2, { principal: "guest-id" }).peer;

  registry.assignPresenter(owner, guest.id, 10);
  assert.equal(registry.moderationSnapshot("pres-room", 1).presenterPeerId, guest.id);

  // Guest leaves -> presenterPeerId reverts to owner
  registry.leave(guest, 20);
  assert.equal(registry.moderationSnapshot("pres-room", 1).presenterPeerId, owner.id);
});

test("presenter assignment is unavailable in pair rooms and for machine peers", () => {
  const registry = new RoomRegistry();
  const pair1 = registry.join("pair-room", {}, "A", 1, { mode: "pair", principal: "p1" }).peer;
  const pair2 = registry.join("pair-room", {}, "B", 2, { mode: "pair", principal: "p2" }).peer;

  assert.throws(() => registry.assignPresenter(pair1, pair2.id, 10), errorCode("moderation_unavailable"));

  const machineRoom = new RoomRegistry();
  const human = machineRoom.join("bot-room", {}, "Human", 1, { principal: "human", machineReceiveVersion: 1 }).peer;
  const bot = machineRoom.join("bot-room", {}, "Bot", 2, {
    principal: "bot",
    machine: true,
    machineReceiveVersion: 1,
    machineCapabilities: ["screen.publish", "avatar.publish"],
  }).peer;

  assert.throws(() => machineRoom.assignPresenter(human, bot.id, 10), errorCode("moderation_unavailable"));
});

test("presenter assignment is rate-limited against flood", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("pres-room", {}, "Owner", 1, { principal: "owner-id" }).peer;
  const guest = registry.join("pres-room", {}, "Guest", 2, { principal: "guest-id" }).peer;

  // Rapid toggling reaches rate limit (HAND_RATE_LIMIT = 6)
  for (let i = 0; i < 6; i++) {
    const target = i % 2 === 0 ? guest.id : owner.id;
    assert.equal(registry.assignPresenter(owner, target, 1000 + i), true);
  }

  assert.throws(() => registry.assignPresenter(owner, guest.id, 1010), errorCode("moderation_rate_limited"));
});
