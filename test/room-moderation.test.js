import assert from "node:assert/strict";
import test from "node:test";

import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { RoomAdmissionError, RoomRegistry } from "../src/room-registry.js";
import { REMOVE_UNDO_MS, RoomModerationError, handQueue, moderationSnapshot, peerRole } from "../src/room-moderation.js";

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
  assert.equal(snapshot.participants.every((item) => item.raisedAt === 0 && item.hand === "none"), true);
  assert.deepEqual(snapshot.queue, []);
  assert.equal(Object.hasOwn(snapshot, "audit"), false);
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

test("hand queue is FIFO by server raisedAt with peer-id tie-break and survives owner change", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const first = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  const second = registry.join("room-mod", {}, "Linus", 3, { principal: "other" }).peer;
  registry.setHand(second, "raised", 40);
  registry.setHand(first, "raised", 10);
  registry.setHand(owner, "raised", 10);
  const snapshot = registry.moderationSnapshot("room-mod", 1);
  assert.deepEqual(snapshot.queue, [first, owner, second]
    .sort((left, right) => left.handRaisedAt - right.handRaisedAt || left.id.localeCompare(right.id))
    .map((peer) => peer.id));
  assert.equal(snapshot.participants.find((item) => item.peerId === first.id).raisedAt, 10);
  registry.clearHand(owner, first.id, 50);
  assert.deepEqual(registry.moderationSnapshot("room-mod", 1).queue, [owner.id, second.id]);
  assert.deepEqual(handQueue(null), []);
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

test("only the owner may remove another peer, never self, pair or machines", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  assert.throws(() => registry.authorizeRemove(guest, owner.id, 11), errorCode("moderation_forbidden"));
  assert.throws(() => registry.authorizeRemove(owner, owner.id, 12), errorCode("self_moderation_forbidden"));
  assert.equal(registry.authorizeRemove(owner, guest.id, 13), true);
  assert.equal(registry.hasPendingRemove("room-mod"), true);
  assert.equal(registry.dueRemove("room-mod", 13 + REMOVE_UNDO_MS - 1), null);
  assert.equal(registry.cancelRemove(owner, 14), true);
  assert.equal(registry.hasPendingRemove("room-mod"), false);
  const pair = registry.join("pair-room", {}, "One", 1, { mode: "pair", principal: "one" }).peer;
  const pairTwo = registry.join("pair-room", {}, "Two", 2, { mode: "pair", principal: "two" }).peer;
  assert.throws(() => registry.authorizeRemove(pair, pairTwo.id, 3), errorCode("moderation_unavailable"));
  const bot = registry.join("room-bot", {}, "Bot", 2, { principal: "bot", machine: true, machineReceiveVersion: 1 }).peer;
  const botTwo = registry.join("room-bot", {}, "Bot2", 3, { principal: "bot2", machine: true, machineReceiveVersion: 1 }).peer;
  assert.throws(() => registry.authorizeRemove(bot, botTwo.id, 4), errorCode("moderation_unavailable"));
});

test("hand messages are closed and unknown fields fail", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "hand-raise" })), { type: "hand-raise" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "hand-lower" })), { type: "hand-lower" });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "hand-raise", extra: true })), /unknown_message_field/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "hand-clear" })), /invalid_recipient/);
  const remove = parseClientMessage(JSON.stringify({ type: "peer-remove", targetPeerId: "aaaaaaaaaaaaaaaa" }));
  assert.equal(remove.targetPeerId, "aaaaaaaaaaaaaaaa");
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "peer-remove", extra: true })), /unknown_message_field/);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "peer-remove-cancel" })), { type: "peer-remove-cancel" });
  assert.equal(parseClientMessage(JSON.stringify({ type: "presenter-assign", targetPeerId: "aaaaaaaaaaaaaaaa" })).type, "presenter-assign");
  const stop = parseClientMessage(JSON.stringify({
    type: "publication-stop", targetPeerId: "aaaaaaaaaaaaaaaa", source: "microphone",
  }));
  assert.equal(stop.source, "microphone");
  assert.throws(() => parseClientMessage(JSON.stringify({
    type: "publication-stop", targetPeerId: "aaaaaaaaaaaaaaaa", source: "screen-audio",
  })), /invalid_media_source/);
  const clear = parseClientMessage(JSON.stringify({ type: "hand-clear", targetPeerId: "aaaaaaaaaaaaaaaa" }));
  assert.equal(clear.targetPeerId, "aaaaaaaaaaaaaaaa");
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "hand-role", role: "owner" })),
    (error) => error instanceof ProtocolError && error.code === "unknown_message_type");
  assert.equal(moderationSnapshot(null, 1), null);
  assert.throws(() => new RoomRegistry().setHand({ id: "x", roomId: "missing" }, "raised"),
    (error) => error instanceof RoomAdmissionError || error instanceof RoomModerationError);
});

test("volatile audit is owner-only, identity-free and wiped with the room", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  registry.setHand(guest, "raised", 10);
  registry.clearHand(owner, guest.id, 11);
  registry.authorizePublicationStop(owner, guest.id, "microphone", 12);
  const ownerView = registry.moderationSnapshot("room-mod", 1, { audit: true });
  const guestView = registry.moderationSnapshot("room-mod", 1);
  assert.equal(ownerView.audit.length, 3);
  assert.deepEqual(ownerView.audit.map((item) => item.action), ["hand-raise", "hand-clear", "publication-stop"]);
  assert.equal(ownerView.audit[2].source, "microphone");
  assert.equal(Object.hasOwn(guestView, "audit"), false);
  assert.doesNotMatch(JSON.stringify(ownerView), /Ada|Grace|microphone_track|sdp/i);
  registry.leave(owner, 13);
  registry.leave(guest, 14);
  assert.equal(registry.moderationSnapshot("room-mod", 1), null);
});

test("publication stop is owner-only and never a capture grant", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  assert.throws(() => registry.authorizePublicationStop(guest, owner.id, "camera", 2), errorCode("moderation_forbidden"));
  assert.throws(() => registry.authorizePublicationStop(owner, owner.id, "camera", 3), errorCode("self_moderation_forbidden"));
  assert.throws(() => registry.authorizePublicationStop(owner, guest.id, "screen-audio", 4), errorCode("invalid_publication_source"));
  assert.equal(registry.authorizePublicationStop(owner, guest.id, "camera", 5), true);
});

test("presenter assignment is owner-authored and never starts capture", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  assert.equal(registry.moderationSnapshot("room-mod", 1).presenterPeerId, owner.id);
  assert.equal(registry.assignPresenter(owner, guest.id, 3), true);
  assert.equal(registry.moderationSnapshot("room-mod", 1).presenterPeerId, guest.id);
  assert.throws(() => registry.assignPresenter(guest, owner.id, 4), errorCode("moderation_forbidden"));
  registry.leave(guest, 5);
  assert.equal(registry.moderationSnapshot("room-mod", 1).presenterPeerId, owner.id);
});

test("scheduled remove expires only after the undo window", () => {
  const registry = new RoomRegistry();
  const owner = registry.join("room-mod", {}, "Ada", 1, { principal: "owner" }).peer;
  const guest = registry.join("room-mod", {}, "Grace", 2, { principal: "guest" }).peer;
  registry.authorizeRemove(owner, guest.id, 20);
  assert.equal(registry.moderationSnapshot("room-mod", 1, { audit: true }).pendingRemove.targetPeerId, guest.id);
  assert.equal(registry.dueRemove("room-mod", 20 + REMOVE_UNDO_MS), guest.id);
  assert.equal(registry.hasPendingRemove("room-mod"), false);
  assert.equal(guest.hand, "none");
});
