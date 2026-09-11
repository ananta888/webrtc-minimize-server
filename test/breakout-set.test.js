import assert from "node:assert/strict";
import test from "node:test";

import {
  BreakoutError, BreakoutRegistry, DEFAULT_BREAKOUT_LIFETIME_MS, roomsShareMembership,
} from "../src/breakout-set.js";
import { RoomAdmissionError, RoomFullError, RoomRegistry } from "../src/room-registry.js";

const code = (expected) => (error) => error instanceof BreakoutError && error.code === expected;
const admission = (expected) => (error) => error instanceof RoomAdmissionError && error.code === expected;

function registry() {
  return new RoomRegistry({ breakouts: new BreakoutRegistry() });
}

test("breakout children have independent room IDs, epochs and no shared membership", () => {
  const rooms = registry();
  const owner = rooms.join("room-parent1", {}, "Ada", 1, { principal: "owner" }).peer;
  const parent = rooms.join("room-parent1", {}, "Grace", 2, { principal: "guest" }).peer;
  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 4 }, 10);
  assert.equal(set.type, "breakout-set");
  assert.equal(set.parentRoomId, "room-parent1");
  assert.equal(set.parentRevision, 1);
  assert.equal(set.state, "open");
  assert.equal(set.expiresAt, 10 + DEFAULT_BREAKOUT_LIFETIME_MS);
  assert.equal(set.children.length, 2);
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
  const owner = rooms.join("room-parent2", {}, "Ada", 1, { principal: "owner" }).peer;
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 3 }, 20);
  const childId = set.children[0].roomId;
  assert.throws(() => rooms.join(childId, {}, "Intruder", 21), admission("breakout_assignment_required"));
  assert.throws(
    () => rooms.join(childId, {}, "WrongSet", 21, { breakoutSetId: "deadbeefdeadbeef", breakoutChildRoomId: childId }),
    admission("breakout_assignment_required"),
  );
  assert.deepEqual(rooms.members(childId), []);
  assert.equal(rooms.reservedBreakout(childId).setId, set.setId);
});

test("authorized child join is isolated from parent and sibling rooms", () => {
  const rooms = registry();
  const owner = rooms.join("room-parent3", {}, "Ada", 1, { principal: "owner" }).peer;
  const parentGuest = rooms.join("room-parent3", {}, "Grace", 2, { principal: "guest" }).peer;
  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 3 }, 30);
  const left = set.children[0];
  const right = set.children[1];
  const childA = rooms.join(left.roomId, {}, "ChildA", 31, {
    principal: "a", breakoutSetId: set.setId, breakoutChildRoomId: left.roomId,
  }).peer;
  const childB = rooms.join(right.roomId, {}, "ChildB", 32, {
    principal: "b", breakoutSetId: set.setId, breakoutChildRoomId: right.roomId,
  }).peer;
  assert.equal(childA.roomId, left.roomId);
  assert.notEqual(childA.id, owner.id);
  assert.equal(rooms.recipient(owner, childA.id), null);
  assert.equal(rooms.recipient(childA, owner.id), null);
  assert.equal(rooms.recipient(childA, parentGuest.id), null);
  assert.equal(rooms.recipient(childA, childB.id), null);
  assert.deepEqual(rooms.members(left.roomId).map((peer) => peer.id), [childA.id]);
  assert.deepEqual(rooms.members("room-parent3").map((peer) => peer.id).sort(), [owner.id, parentGuest.id].sort());
  assert.equal(rooms.members(left.roomId).every((peer) => peer.roomId === left.roomId), true);
});

test("each concrete room keeps its own 20-member cap", () => {
  const rooms = registry();
  const owner = rooms.join("room-parent4", {}, "Owner", 1, { principal: "owner" }).peer;
  for (let index = 1; index < 20; index += 1) rooms.join("room-parent4", {}, `P${index}`, index + 1, { principal: `p${index}` });
  assert.throws(() => rooms.join("room-parent4", {}, "Overflow", 40, { principal: "x" }), RoomFullError);
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 20 }, 50);
  const childId = set.children[0].roomId;
  const grant = { breakoutSetId: set.setId, breakoutChildRoomId: childId };
  for (let index = 0; index < 20; index += 1) {
    rooms.join(childId, {}, `C${index}`, 60 + index, { principal: `c${index}`, ...grant });
  }
  assert.throws(() => rooms.join(childId, {}, "C20", 90, { principal: "c20", ...grant }), RoomFullError);
  assert.equal(rooms.members("room-parent4").length, 20);
  assert.equal(rooms.members(childId).length, 20);
});

test("pair rooms, nested children and non-owners cannot open a set", () => {
  const rooms = registry();
  const pair = rooms.join("pair-abcdef", {}, "Ada", 1, { mode: "pair", principal: "owner" }).peer;
  assert.throws(() => rooms.openBreakouts(pair, { childCount: 1, capacity: 2 }, 2), admission("breakout_pair_denied"));
  const owner = rooms.join("room-parent5", {}, "Ada", 3, { principal: "owner" }).peer;
  const guest = rooms.join("room-parent5", {}, "Grace", 4, { principal: "guest" }).peer;
  assert.throws(() => rooms.openBreakouts(guest, { childCount: 1, capacity: 2 }, 5), admission("breakout_owner_required"));
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 6);
  assert.throws(() => rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 7), admission("breakout_set_exists"));
  const child = rooms.join(set.children[0].roomId, {}, "InChild", 8, {
    principal: "owner", breakoutSetId: set.setId, breakoutChildRoomId: set.children[0].roomId,
  }).peer;
  assert.throws(() => rooms.openBreakouts(child, { childCount: 1, capacity: 2 }, 9), admission("breakout_nested_denied"));
  assert.throws(() => new BreakoutRegistry().openSet({
    parentRoomId: "room-parent5", parentMode: "room", parentKind: "room", ownerRole: "owner",
    childCount: 11, capacity: 2, now: 1,
  }), code("invalid_breakout_count"));
});

test("closing or expiring a set evicts children and invalidates old grants", () => {
  const rooms = registry();
  const owner = rooms.join("room-parent6", {}, "Ada", 1, { principal: "owner" }).peer;
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2, lifetimeMs: 60_000 }, 100);
  const childId = set.children[0].roomId;
  const grant = { breakoutSetId: set.setId, breakoutChildRoomId: childId, principal: "child" };
  const child = rooms.join(childId, {}, "Child", 110, grant).peer;
  const evicted = rooms.closeBreakouts("room-parent6", 120);
  assert.deepEqual(evicted.map((peer) => peer.id), [child.id]);
  assert.deepEqual(rooms.members(childId), []);
  assert.equal(rooms.reservedBreakout(childId), null);
  assert.throws(() => rooms.join(childId, {}, "Late", 130, grant), admission("breakout_assignment_required"));
  const again = rooms.openBreakouts(owner, { childCount: 1, capacity: 2, lifetimeMs: 60_000 }, 200);
  rooms.join(again.children[0].roomId, {}, "Temp", 210, {
    principal: "t", breakoutSetId: again.setId, breakoutChildRoomId: again.children[0].roomId,
  });
  rooms.prune(200 + 60_000);
  assert.equal(rooms.reservedBreakout(again.children[0].roomId), null);
  assert.deepEqual(rooms.members(again.children[0].roomId), []);
});

test("empty parent leave closes reserved children", () => {
  const rooms = registry();
  const owner = rooms.join("room-parent7", {}, "Ada", 1, { principal: "owner" }).peer;
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 1);
  rooms.join(set.children[0].roomId, {}, "Child", 2, {
    principal: "c", breakoutSetId: set.setId, breakoutChildRoomId: set.children[0].roomId,
  });
  rooms.leave(owner, 3);
  assert.equal(rooms.reservedBreakout(set.children[0].roomId), null);
  assert.deepEqual(rooms.members(set.children[0].roomId), []);
});
