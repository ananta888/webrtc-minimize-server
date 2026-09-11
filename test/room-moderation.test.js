import assert from "node:assert/strict";
import test from "node:test";

import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { RoomAdmissionError, RoomRegistry } from "../src/room-registry.js";
import { RoomModerationError, moderationSnapshot, peerRole } from "../src/room-moderation.js";

const errorCode = (code) => (error) => error instanceof RoomModerationError && error.code === code;

test("owner and participant roles come only from membership, never from client payloads", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "https://id/|ada" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "https://id/|grace" }).peer;
  assert.equal(peerRole(owner, "https://id/|ada"), "owner");
  assert.equal(peerRole(guest, "https://id/|ada"), "participant");
  guest.creator = true;
  assert.equal(peerRole(guest, "https://id/|ada"), "participant");
  const snapshot = registry.moderationSnapshot("room-mod", 1);
  assert.equal(snapshot.type, "moderation-state");
  assert.equal(snapshot.membershipEpoch, 1);
  assert.deepEqual(snapshot.participants.map((item) => item.role).sort(), ["owner", "participant"].sort());
  assert.doesNotMatch(JSON.stringify(snapshot), /Ada|Grace|https:\/\/id/);
});

test("hand raise is idempotent, pair and machine unavailable, and leave wipes state", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  registry.setHand(owner, "raised", 1_000);
  registry.setHand(owner, "raised", 1_001);
  assert.equal(owner.hand, "raised");
  registry.setHand(owner, "none", 1_002);
  assert.equal(owner.hand, "none");
  const machine = registry.join("room-bot", {}, "Bot", 2, { principal: "bot", machine: true, machineReceiveVersion: 1 }).peer;
  assert.throws(() => registry.setHand(machine, "raised", 3), errorCode("hand_unavailable"));
  const pair = registry.join("pair-room", {}, "One", 1, { mode: "pair", principal: "one" }).peer;
  assert.throws(() => registry.setHand(pair, "raised", 2), errorCode("hand_unavailable"));
  registry.setHand(owner, "raised", 4_000);
  const other = registry.join("room-mod", {}, "Grace", 5_000, { principal: "guest" }).peer;
  registry.leave(owner, 6_000);
  assert.equal(owner.hand, "none");
  assert.equal(registry.moderationSnapshot("room-mod", 2).participants.some((item) => item.peerId === owner.id), false);
  assert.equal(other.hand, "none");
});

test("only the owner may clear another hand and rate limits apply", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  registry.setHand(guest, "raised", 10);
  assert.throws(() => registry.clearHand(guest, owner.id, 11), errorCode("moderation_forbidden"));
  registry.clearHand(owner, guest.id, 12);
  assert.equal(guest.hand, "none");
  const other = registry.join("room-mod", {}, "Linus", 3, { principal: "other" }).peer;
  for (let index = 0; index < 6; index++) registry.setHand(other, index % 2 ? "none" : "raised", 100 + index);
  assert.throws(() => registry.setHand(other, "raised", 106), errorCode("hand_rate_limited"));
  registry.setHand(other, "raised", 100 + 10_000);
  assert.equal(other.hand, "raised");
});

test("hand messages are closed and unknown fields fail", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "hand-raise" })), { type: "hand-raise" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "hand-lower" })), { type: "hand-lower" });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "hand-raise", extra: true })), /unknown_message_field/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "hand-clear" })), /invalid_recipient/);
  const clear = parseClientMessage(JSON.stringify({ type: "hand-clear", targetPeerId: "aaaaaaaaaaaaaaaa" }));
  assert.equal(clear.targetPeerId, "aaaaaaaaaaaaaaaa");
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "hand-role", role: "owner" })),
    (error) => error instanceof ProtocolError && error.code === "unknown_message_type");
  assert.equal(moderationSnapshot(null, 1), null);
  assert.throws(() => new RoomRegistry().setHand({ id: "x", roomId: "missing" }, "raised"),
    (error) => error instanceof RoomAdmissionError || error instanceof RoomModerationError);
});
