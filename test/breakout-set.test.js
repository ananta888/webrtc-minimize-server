import assert from "node:assert/strict";
import test from "node:test";

import {
  BreakoutError, BreakoutRegistry, DEFAULT_BREAKOUT_LIFETIME_MS, roomsShareMembership,
} from "../src/breakout-set.js";
import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { RoomAdmissionError, RoomFullError, RoomRegistry } from "../src/room-registry.js";

const code = (expected) => (error) => error instanceof BreakoutError && error.code === expected;
const admission = (expected) => (error) => error instanceof RoomAdmissionError && error.code === expected;

function registry() {
  return new RoomRegistry({ breakouts: new BreakoutRegistry() });
}

function joinParent(rooms, roomId, name, now, principal) {
  return rooms.join(roomId, {}, name, now, {
    principal, deviceFingerprint: `device-${principal}`.padEnd(12, "0"),
  }).peer;
}

function joinChild(rooms, peer, set, childRoomId, now) {
  rooms.leave(peer, now);
  return rooms.join(childRoomId, {}, peer.name, now + 1, {
    principal: peer.principal,
    deviceFingerprint: peer.deviceFingerprint,
    breakoutSetId: set.setId,
    breakoutChildRoomId: childRoomId,
  }).peer;
}

test("breakout children have independent room IDs, epochs and no shared membership", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent1", "Ada", 1, "owner");
  const parent = joinParent(rooms, "room-parent1", "Grace", 2, "guest");
  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 4 }, 10);
  assert.equal(set.type, "breakout-set");
  assert.equal(set.parentRoomId, "room-parent1");
  assert.equal(set.parentRevision, 1);
  assert.equal(set.state, "open");
  assert.equal(set.expiresAt, 10 + DEFAULT_BREAKOUT_LIFETIME_MS);
  assert.equal(set.children.length, 2);
  assert.equal(set.grants.length, 0);
  assert.equal(new Set(set.children.map((child) => child.roomId)).size, 2);
  assert.equal(set.children.some((child) => child.roomId === "room-parent1"), false);
  for (const child of set.children) {
    assert.match(child.roomId, /^brk-[a-f0-9]{24}$/);
    assert.equal(child.state, "open");
    assert.equal(child.capacity, 4);
    assert.equal(child.membershipEpoch, 1);
    assert.equal(child.topologyEpoch, 1);
    assert.equal(child.routeEpoch, 1);
    assert.equal(child.securityEpoch, 1);
    assert.equal(roomsShareMembership("room-parent1", child.roomId), false);
  }
  assert.equal(roomsShareMembership(set.children[0].roomId, set.children[1].roomId), false);
  assert.equal(JSON.stringify(set).includes("Ada") || JSON.stringify(set).includes(owner.id), false);
  assert.equal(rooms.recipient(parent, owner.id), owner);
});

test("guessing a child room ID does not create or join membership", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent2", "Ada", 1, "owner");
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 3 }, 20);
  const childId = set.children[0].roomId;
  assert.throws(() => rooms.join(childId, {}, "Intruder", 21), admission("breakout_assignment_required"));
  assert.throws(
    () => rooms.join(childId, {}, "WrongSet", 21, {
      principal: "intruder", deviceFingerprint: "device-intruder",
      breakoutSetId: "deadbeefdeadbeef", breakoutChildRoomId: childId,
    }),
    admission("breakout_assignment_required"),
  );
  assert.deepEqual(rooms.members(childId), []);
  assert.equal(rooms.reservedBreakout(childId).setId, set.setId);
});

test("grants bind principal, device, parent revision and expire once", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent3", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent3", "Grace", 2, "guest");
  const other = joinParent(rooms, "room-parent3", "Linus", 3, "other");
  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 2 }, 30);
  const left = set.children[0].roomId;
  const right = set.children[1].roomId;
  assert.throws(() => rooms.assignBreakout(guest, { targetPeerId: owner.id, childRoomId: left }, 31),
    admission("breakout_owner_required"));
  const grant = rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId: left, ttlMs: 15_000 }, 40);
  assert.equal(grant.childRoomId, left);
  assert.equal(grant.targetPeerId, guest.id);
  assert.equal(grant.parentRevision, 1);
  assert.equal(grant.consumed, false);
  assert.equal(grant.expiresAt, 15_040);
  assert.equal(JSON.stringify(grant).includes(guest.principal), false);
  assert.equal(JSON.stringify(grant).includes(guest.deviceFingerprint), false);
  assert.throws(() => rooms.join(left, {}, other.name, 41, {
    principal: other.principal, deviceFingerprint: other.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: left,
  }), admission("breakout_parallel_membership"));
  assert.throws(() => rooms.join(left, {}, "Spoof", 42, {
    principal: guest.principal, deviceFingerprint: other.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: left,
  }), admission("breakout_assignment_required"));
  assert.throws(() => rooms.join(left, {}, "Parallel", 42.5, {
    principal: guest.principal, deviceFingerprint: guest.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: left,
  }), admission("breakout_parallel_membership"));
  const childGuest = joinChild(rooms, guest, set, left, 43);
  assert.notEqual(childGuest.id, guest.id);
  assert.equal(rooms.recipient(owner, childGuest.id), null);
  assert.throws(() => rooms.join(left, {}, "Replay", 44, {
    principal: guest.principal, deviceFingerprint: guest.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: left,
  }), admission("breakout_assignment_required"));
  rooms.assignBreakout(owner, { targetPeerId: other.id, childRoomId: right }, 50);
  const replaced = rooms.assignBreakout(owner, { targetPeerId: other.id, childRoomId: left }, 51);
  assert.equal(replaced.childRoomId, left);
  rooms.leave(other, 52);
  assert.throws(() => rooms.join(right, {}, other.name, 53, {
    principal: other.principal, deviceFingerprint: other.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: right,
  }), admission("breakout_assignment_required"));
  rooms.revokeBreakout(owner, replaced.grantId, 54);
  assert.throws(() => rooms.join(left, {}, other.name, 55, {
    principal: other.principal, deviceFingerprint: other.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: left,
  }), admission("breakout_assignment_required"));
});

test("authorized child join is isolated from parent and sibling rooms", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent4", "Ada", 1, "owner");
  const parentGuest = joinParent(rooms, "room-parent4", "Grace", 2, "guest");
  const leftPeer = joinParent(rooms, "room-parent4", "ChildA", 3, "a");
  const rightPeer = joinParent(rooms, "room-parent4", "ChildB", 4, "b");
  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 3 }, 30);
  const left = set.children[0];
  const right = set.children[1];
  rooms.assignBreakout(owner, { targetPeerId: leftPeer.id, childRoomId: left.roomId }, 31);
  rooms.assignBreakout(owner, { targetPeerId: rightPeer.id, childRoomId: right.roomId }, 32);
  const childA = joinChild(rooms, leftPeer, set, left.roomId, 33);
  const childB = joinChild(rooms, rightPeer, set, right.roomId, 34);
  assert.equal(childA.roomId, left.roomId);
  assert.notEqual(childA.id, owner.id);
  assert.equal(rooms.recipient(owner, childA.id), null);
  assert.equal(rooms.recipient(childA, owner.id), null);
  assert.equal(rooms.recipient(childA, parentGuest.id), null);
  assert.equal(rooms.recipient(childA, childB.id), null);
  assert.deepEqual(rooms.members(left.roomId).map((peer) => peer.id), [childA.id]);
  assert.equal(rooms.members("room-parent4").length, 2);
});

test("each concrete room keeps its own 20-member cap", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent5", "Owner", 1, "owner");
  const parentPeers = [owner];
  for (let index = 1; index < 20; index += 1) {
    parentPeers.push(joinParent(rooms, "room-parent5", `P${index}`, index + 1, `p${index}`));
  }
  assert.throws(() => joinParent(rooms, "room-parent5", "Overflow", 40, "x"), RoomFullError);
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 20 }, 50);
  const childId = set.children[0].roomId;
  for (const peer of parentPeers) {
    rooms.assignBreakout(owner, { targetPeerId: peer.id, childRoomId: childId }, 60);
  }
  for (let index = 0; index < 20; index += 1) {
    joinChild(rooms, parentPeers[index], set, childId, 70 + index);
  }
  assert.equal(rooms.members("room-parent5").length, 0);
  assert.equal(rooms.members(childId).length, 20);
  for (let index = 0; index < 20; index += 1) {
    joinParent(rooms, "room-parent5", `N${index}`, 200 + index, `n${index}`);
  }
  assert.equal(rooms.members("room-parent5").length, 20);
  assert.throws(() => rooms.join(childId, {}, "C20", 300, {
    principal: "c20", deviceFingerprint: "device-c20xx",
    breakoutSetId: set.setId, breakoutChildRoomId: childId,
  }), admission("breakout_assignment_required"));
});

test("pair rooms, nested children and non-owners cannot open a set", () => {
  const rooms = registry();
  const pair = rooms.join("pair-abcdef", {}, "Ada", 1, {
    mode: "pair", principal: "owner", deviceFingerprint: "device-pair1",
  }).peer;
  assert.throws(() => rooms.openBreakouts(pair, { childCount: 1, capacity: 2 }, 2), admission("breakout_pair_denied"));
  const owner = joinParent(rooms, "room-parent6", "Ada", 3, "owner");
  const guest = joinParent(rooms, "room-parent6", "Grace", 4, "guest");
  assert.throws(() => rooms.openBreakouts(guest, { childCount: 1, capacity: 2 }, 5), admission("breakout_owner_required"));
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 6);
  assert.throws(() => rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 7), admission("breakout_set_exists"));
  rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId: set.children[0].roomId }, 8);
  const child = joinChild(rooms, guest, set, set.children[0].roomId, 9);
  assert.throws(() => rooms.openBreakouts(child, { childCount: 1, capacity: 2 }, 10), admission("breakout_nested_denied"));
  assert.throws(() => new BreakoutRegistry().openSet({
    parentRoomId: "room-parent6", parentMode: "room", parentKind: "room", ownerRole: "owner",
    childCount: 11, capacity: 2, now: 1,
  }), code("invalid_breakout_count"));
});

test("closing or expiring a set evicts children and invalidates old grants", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent7", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent7", "Kid", 2, "child");
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2, lifetimeMs: 60_000 }, 100);
  const childId = set.children[0].roomId;
  rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId: childId }, 110);
  const child = joinChild(rooms, guest, set, childId, 111);
  const evicted = rooms.closeBreakouts("room-parent7", 120);
  assert.deepEqual(evicted.map((peer) => peer.id), [child.id]);
  assert.deepEqual(rooms.members(childId), []);
  assert.equal(rooms.reservedBreakout(childId), null);
  assert.throws(() => rooms.join(childId, {}, "Late", 130, {
    principal: guest.principal, deviceFingerprint: guest.deviceFingerprint,
    breakoutSetId: set.setId, breakoutChildRoomId: childId,
  }), admission("breakout_assignment_required"));
  const again = rooms.openBreakouts(owner, { childCount: 1, capacity: 2, lifetimeMs: 60_000 }, 200);
  const returning = joinParent(rooms, "room-parent7", "Kid", 205, "child");
  rooms.assignBreakout(owner, { targetPeerId: returning.id, childRoomId: again.children[0].roomId }, 210);
  joinChild(rooms, returning, again, again.children[0].roomId, 211);
  rooms.prune(200 + 60_000);
  assert.equal(rooms.reservedBreakout(again.children[0].roomId), null);
  assert.deepEqual(rooms.members(again.children[0].roomId), []);
});

test("empty parent leave keeps reserved children until close or expiry", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent8", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent8", "Grace", 2, "guest");
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 3);
  rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId: set.children[0].roomId }, 4);
  const child = joinChild(rooms, guest, set, set.children[0].roomId, 5);
  rooms.leave(owner, 6);
  assert.equal(rooms.reservedBreakout(set.children[0].roomId).setId, set.setId);
  assert.deepEqual(rooms.members(set.children[0].roomId).map((peer) => peer.id), [child.id]);
});

test("breakout assignment messages are closed and content-free", () => {
  const assigned = parseClientMessage(JSON.stringify({
    type: "breakout-assign", targetPeerId: "aaaaaaaaaaaaaaaa", childRoomId: "brk-abababababababababababab",
  }));
  assert.equal(assigned.type, "breakout-assign");
  assert.equal(assigned.childRoomId, "brk-abababababababababababab");
  assert.throws(() => parseClientMessage(JSON.stringify({
    type: "breakout-assign", targetPeerId: "aaaaaaaaaaaaaaaa", childRoomId: "brk-x", extra: true,
  })), (error) => error instanceof ProtocolError && error.code === "unknown_message_field");
  assert.deepEqual(parseClientMessage(JSON.stringify({
    type: "breakout-revoke", grantId: "bbbbbbbbbbbbbbbb",
  })), { type: "breakout-revoke", grantId: "bbbbbbbbbbbbbbbb" });
  assert.deepEqual(parseClientMessage(JSON.stringify({
    type: "breakout-open", childCount: 2, capacity: 10,
  })), { type: "breakout-open", childCount: 2, capacity: 10 });
});
