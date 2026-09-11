import assert from "node:assert/strict";
import test from "node:test";

import {
  BreakoutError, BreakoutRegistry, DEFAULT_BREAKOUT_LIFETIME_MS, MIN_BREAKOUT_GRANT_MS, roomsShareMembership,
} from "../src/breakout-set.js";
import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { RoomAdmissionError, RoomFullError, RoomRegistry } from "../src/room-registry.js";
import { createEdgeTurnCredentials, createTurnCredentials } from "../src/turn-credentials.js";
import { buildRoomTopology } from "../src/media-topology.js";

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

test("breakout sessions get child-bound, short-lived TURN credentials without inheriting parent consent", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent9", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent9", "Grace", 2, "guest");
  rooms.setRelayConsent(owner, true, 3);
  rooms.setRelayConsent(guest, true, 3);
  assert.equal(owner.relayConsent, true);
  assert.equal(guest.relayConsent, true);

  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2, lifetimeMs: 60_000 }, 10);
  const childRoomId = set.children[0].roomId;
  rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId }, 20);

  const childPeer = joinChild(rooms, guest, set, childRoomId, 25);
  // Parent relay consent must NOT be inherited
  assert.equal(childPeer.relayConsent, false);

  const turnConfig = {
    turnUrls: ["turn:turn.example.com:3478"],
    turnSharedSecret: "test-secret-12345",
    turnCredentialTtlMs: 24 * 60 * 60 * 1000,
  };
  const parentTurn = createTurnCredentials(turnConfig, guest.principal, 25);
  const reserved = rooms.reservedBreakout(childRoomId);
  const childTurnTtlMs = Math.min(
    turnConfig.turnCredentialTtlMs,
    Math.max(MIN_BREAKOUT_GRANT_MS, reserved.expiresAt - 25),
  );
  const childTurn = createTurnCredentials(
    turnConfig,
    `${childPeer.principal}:breakout:${childRoomId}`,
    25,
    childTurnTtlMs,
  );

  assert.equal(parentTurn.length, 1);
  assert.equal(childTurn.length, 1);
  assert.notEqual(parentTurn[0].username, childTurn[0].username);
  // Child TURN username must expire with the child lifetime, not the full 24h
  const childExpiresAt = Number(childTurn[0].username.split(":")[0]);
  const parentExpiresAt = Number(parentTurn[0].username.split(":")[0]);
  assert.ok(childExpiresAt < parentExpiresAt);
  assert.equal(childExpiresAt, Math.floor((25 + childTurnTtlMs) / 1000));
});

test("media agents and relay topology in breakout rooms are isolated from parent publications and neighbor rooms", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent10", "Ada", 1, "owner");
  const guest1 = joinParent(rooms, "room-parent10", "Grace", 2, "guest1");
  const guest2 = joinParent(rooms, "room-parent10", "Linus", 3, "guest2");

  rooms.setMediaState(owner, { source: "camera", active: true, trackId: "track-owner-cam" }, 4);
  assert.ok(rooms.publication(owner.id, "track-owner-cam", "room-parent10"));

  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 4 }, 10);
  const childA = set.children[0].roomId;
  const childB = set.children[1].roomId;

  rooms.assignBreakout(owner, { targetPeerId: guest1.id, childRoomId: childA }, 15);
  rooms.assignBreakout(owner, { targetPeerId: guest2.id, childRoomId: childB }, 15);

  const peerA = joinChild(rooms, guest1, set, childA, 20);
  const peerB = joinChild(rooms, guest2, set, childB, 20);

  // Cross-room publication lookup returns null
  assert.equal(rooms.publication(owner.id, "track-owner-cam", childA), null);
  assert.equal(rooms.publication(owner.id, "track-owner-cam", childB), null);

  // Topology for childA only contains peerA, never owner or peerB
  const epochs = { membership: 1, route: 1, topology: 1 };
  const topologyA = buildRoomTopology(rooms.members(childA), epochs, {
    enabled: true, minimumParticipants: 1, maxChildren: 2, maxHops: 2, leaseMs: 10_000, blockedRelayIds: [],
  });
  assert.deepEqual(topologyA.peers, [peerA.id]);

  // Topology for parent room only contains remaining parent member
  const topologyParent = buildRoomTopology(rooms.members("room-parent10"), epochs, {
    enabled: true, minimumParticipants: 1, maxChildren: 2, maxHops: 2, leaseMs: 10_000, blockedRelayIds: [],
  });
  assert.deepEqual(topologyParent.peers, [owner.id]);
});

test("balanced policy assigns candidate peers evenly and respects child room capacity", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent11", "Ada", 1, "owner");
  const guest1 = joinParent(rooms, "room-parent11", "Grace", 2, "g1");
  const guest2 = joinParent(rooms, "room-parent11", "Linus", 3, "g2");
  const guest3 = joinParent(rooms, "room-parent11", "Tim", 4, "g3");

  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 2 }, 10);
  const childA = set.children[0].roomId;
  const childB = set.children[1].roomId;

  // Non-owner cannot trigger balanced assignment
  assert.throws(
    () => rooms.assignBreakoutsBalanced(guest1, {}, 11),
    admission("breakout_owner_required"),
  );

  const grants = rooms.assignBreakoutsBalanced(owner, {}, 12);
  assert.equal(grants.length, 3);
  const inA = grants.filter((g) => g.childRoomId === childA).length;
  const inB = grants.filter((g) => g.childRoomId === childB).length;
  assert.equal(inA + inB, 3);
  assert.ok(inA <= 2 && inB <= 2);
  assert.equal(Math.abs(inA - inB), 1); // Balanced distribution

  // Add a 4th guest and run balanced again
  const guest4 = joinParent(rooms, "room-parent11", "Margaret", 5, "g4");
  const grants2 = rooms.assignBreakoutsBalanced(owner, {}, 13);
  assert.equal(grants2.length, 4); // All 4 now assigned (2 in childA, 2 in childB)
  const inA2 = grants2.filter((g) => g.childRoomId === childA).length;
  const inB2 = grants2.filter((g) => g.childRoomId === childB).length;
  assert.equal(inA2, 2);
  assert.equal(inB2, 2);

  // Add 5th guest: capacity is 4 total, 5th cannot fit
  const guest5 = joinParent(rooms, "room-parent11", "Alan", 6, "g5");
  const grants3 = rooms.assignBreakoutsBalanced(owner, {}, 14);
  // Total assigned cannot exceed capacity of open children (4)
  assert.equal(grants3.length, 4);
});

test("voluntary self-selection allows participant choice without elevating privileges", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent12", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent12", "Grace", 2, "g1");

  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 2 }, 10);
  const childA = set.children[0].roomId;

  // Participant chooses child room voluntarily
  const grant = rooms.chooseBreakout(guest, childA, {}, 12);
  assert.equal(grant.childRoomId, childA);
  assert.equal(grant.targetPeerId, guest.id);

  // Guest joins child room with voluntary grant
  const childPeer = joinChild(rooms, guest, set, childA, 15);
  // Privileges are not elevated: peer is not creator and not owner
  assert.equal(childPeer.creator, false);
  assert.notEqual(rooms.peerRole(childPeer), "owner");
  assert.throws(
    () => rooms.assignBreakout(childPeer, { targetPeerId: "someone", childRoomId: childA }, 16),
    admission("breakout_owner_required"),
  );

  // When child is full, voluntary choice fails closed
  const guest2 = joinParent(rooms, "room-parent12", "Linus", 17, "g2");
  const guest3 = joinParent(rooms, "room-parent12", "Tim", 18, "g3");
  rooms.chooseBreakout(guest2, childA, {}, 19);
  assert.throws(
    () => rooms.chooseBreakout(guest3, childA, {}, 20),
    admission("breakout_child_full"),
  );
});

test("conflict resolution and late joins fall back to available children or reject when exhausted", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent13", "Ada", 1, "owner");
  const set = rooms.openBreakouts(owner, { childCount: 2, capacity: 2 }, 10);
  const childA = set.children[0].roomId;
  const childB = set.children[1].roomId;

  // Fill childA (2 peers)
  const guest1 = joinParent(rooms, "room-parent13", "Grace", 2, "g1");
  const guest2 = joinParent(rooms, "room-parent13", "Linus", 3, "g2");
  rooms.chooseBreakout(guest1, childA, {}, 12);
  rooms.chooseBreakout(guest2, childA, {}, 12);

  // Late join / conflict: guest3 prefers childA (which is full), so resolution redirects to childB
  const guest3 = joinParent(rooms, "room-parent13", "Margaret", 4, "g3");
  const resolvedGrant = rooms.resolveBreakoutJoin(guest3, { preferredChildRoomId: childA }, 14);
  assert.equal(resolvedGrant.childRoomId, childB);

  // Fill childB (guest3 + guest4)
  const guest4 = joinParent(rooms, "room-parent13", "Tim", 5, "g4");
  rooms.chooseBreakout(guest4, childB, {}, 14);

  // Now both childA and childB are full; guest5 must be rejected with breakout_all_children_full
  const guest5 = joinParent(rooms, "room-parent13", "Alan", 6, "g5");
  assert.throws(
    () => rooms.resolveBreakoutJoin(guest5, { preferredChildRoomId: childA }, 15),
    admission("breakout_all_children_full"),
  );
});

test("protocol messages for balanced assignment and voluntary choose are validated", () => {
  const balanced = parseClientMessage(JSON.stringify({ type: "breakout-assign-balanced" }));
  assert.deepEqual(balanced, { type: "breakout-assign-balanced" });
  assert.throws(
    () => parseClientMessage(JSON.stringify({ type: "breakout-assign-balanced", extra: true })),
    (error) => error instanceof ProtocolError && error.code === "unknown_message_field",
  );

  const choose = parseClientMessage(JSON.stringify({
    type: "breakout-choose", childRoomId: "brk-0123456789abcdef01234567",
  }));
  assert.deepEqual(choose, {
    type: "breakout-choose", childRoomId: "brk-0123456789abcdef01234567",
  });
  assert.throws(
    () => parseClientMessage(JSON.stringify({
      type: "breakout-choose", childRoomId: "brk-0123456789abcdef01234567", extra: 1,
    })),
    (error) => error instanceof ProtocolError && error.code === "unknown_message_field",
  );

  const help = parseClientMessage(JSON.stringify({ type: "breakout-help-request" }));
  assert.deepEqual(help, { type: "breakout-help-request" });
  assert.throws(
    () => parseClientMessage(JSON.stringify({ type: "breakout-help-request", text: "Help me!" })),
    (error) => error instanceof ProtocolError && error.code === "unknown_message_field",
  );
});

test("breakout help requests are content-free and do not grant owner auto-entry", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent14", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent14", "Grace", 2, "guest");

  // Calling help request from parent room is denied
  assert.throws(
    () => rooms.requestBreakoutHelp(guest, 5),
    admission("breakout_not_child_room"),
  );

  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 10);
  const childRoomId = set.children[0].roomId;
  rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId }, 12);
  const childPeer = joinChild(rooms, guest, set, childRoomId, 15);

  const help = rooms.requestBreakoutHelp(childPeer, 20);
  assert.deepEqual(help, {
    parentRoomId: "room-parent14",
    childRoomId,
    requesterPeerId: childPeer.id,
    requestedAt: 20,
  });

  // Verify help request contains ZERO chat or media payloads
  assert.equal("text" in help || "media" in help || "audio" in help || "video" in help, false);

  // Owner is still strictly in parent room and does NOT auto-join child room
  assert.deepEqual(rooms.members("room-parent14").map((p) => p.id), [owner.id]);
  assert.deepEqual(rooms.members(childRoomId).map((p) => p.id), [childPeer.id]);
});

test("controlled return to parent room clears child publications without restarting capture", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent15", "Ada", 1, "owner");
  const guest = joinParent(rooms, "room-parent15", "Grace", 2, "guest");
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2 }, 10);
  const childRoomId = set.children[0].roomId;
  rooms.assignBreakout(owner, { targetPeerId: guest.id, childRoomId }, 12);
  const childPeer = joinChild(rooms, guest, set, childRoomId, 15);

  // Child peer publishes camera in child room
  rooms.setMediaState(childPeer, { source: "camera", active: true, trackId: "track-child-cam" }, 20);
  assert.ok(rooms.publication(childPeer.id, "track-child-cam", childRoomId));

  // Return to parent: leaves child room first (stopping all media)
  rooms.leave(childPeer, 25);
  assert.equal(rooms.publication(childPeer.id, "track-child-cam", childRoomId), null);
  assert.deepEqual(rooms.members(childRoomId), []);

  // Peer rejoins parent room
  const returnedPeer = rooms.join("room-parent15", {}, guest.name, 26, {
    principal: guest.principal,
    deviceFingerprint: guest.deviceFingerprint,
  }).peer;

  // Returning peer arrives in parent with 0 publications (no auto-capture)
  assert.equal(returnedPeer.publications.size, 0);
  assert.equal(rooms.publication(returnedPeer.id, "track-child-cam", "room-parent15"), null);
});

test("breakout countdown and expiry based on server time clean up sets deterministically", () => {
  const rooms = registry();
  const owner = joinParent(rooms, "room-parent16", "Ada", 1, "owner");
  const set = rooms.openBreakouts(owner, { childCount: 1, capacity: 2, lifetimeMs: 60_000 }, 1_000);

  // Expiration is locked to server timestamp
  assert.equal(set.expiresAt, 61_000);

  // At t=30_000, set is not due
  rooms.prune(30_000);
  assert.ok(rooms.reservedBreakout(set.children[0].roomId));

  // At t=61_001, set is expired and pruned
  rooms.prune(61_001);
  assert.equal(rooms.reservedBreakout(set.children[0].roomId), null);
  assert.equal(rooms.breakoutSnapshot("room-parent16", 61_001), null);
});
