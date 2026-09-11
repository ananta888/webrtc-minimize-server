import crypto from "node:crypto";

import { ROOM_ID_PATTERN } from "./protocol.js";
import { MAX_ROOM_PARTICIPANTS, MIN_ROOM_PARTICIPANTS } from "./room-limits.js";

export const MAX_BREAKOUT_CHILDREN = 10;
export const MIN_BREAKOUT_CHILDREN = 1;
export const MIN_BREAKOUT_LIFETIME_MS = 60_000;
export const MAX_BREAKOUT_LIFETIME_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_BREAKOUT_LIFETIME_MS = 20 * 60 * 1000;

export class BreakoutError extends Error {
  constructor(code) {
    super(code);
    this.name = "BreakoutError";
    this.code = code;
  }
}

function fail(code) {
  throw new BreakoutError(code);
}

function allocateChildRoomId(occupied) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomId = `brk-${crypto.randomBytes(12).toString("hex")}`;
    if (ROOM_ID_PATTERN.test(roomId) && !occupied.has(roomId)) return roomId;
  }
  fail("breakout_room_id_exhausted");
}

function freezeChild(child) {
  return Object.freeze({
    childId: child.childId,
    roomId: child.roomId,
    state: child.state,
    capacity: child.capacity,
    membershipEpoch: child.membershipEpoch,
    topologyEpoch: child.topologyEpoch,
    routeEpoch: child.routeEpoch,
    securityEpoch: child.securityEpoch,
    createdAt: child.createdAt,
    expiresAt: child.expiresAt,
  });
}

export function roomsShareMembership(leftRoomId, rightRoomId) {
  return leftRoomId === rightRoomId;
}

export class BreakoutRegistry {
  #sets = new Map();
  #byChild = new Map();

  openSet({
    parentRoomId,
    parentMode,
    parentKind,
    ownerRole,
    childCount,
    capacity,
    lifetimeMs = DEFAULT_BREAKOUT_LIFETIME_MS,
    now = Date.now(),
    occupiedRoomIds = [],
  }) {
    if (parentMode !== "room") fail("breakout_pair_denied");
    if (parentKind === "breakout") fail("breakout_nested_denied");
    if (ownerRole !== "owner") fail("breakout_owner_required");
    if (typeof parentRoomId !== "string" || !ROOM_ID_PATTERN.test(parentRoomId)) fail("invalid_parent_room");
    if (this.#sets.has(parentRoomId)) fail("breakout_set_exists");
    if (!Number.isSafeInteger(childCount) || childCount < MIN_BREAKOUT_CHILDREN
      || childCount > MAX_BREAKOUT_CHILDREN) fail("invalid_breakout_count");
    if (!Number.isSafeInteger(capacity) || capacity < MIN_ROOM_PARTICIPANTS
      || capacity > MAX_ROOM_PARTICIPANTS) fail("invalid_breakout_capacity");
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < MIN_BREAKOUT_LIFETIME_MS
      || lifetimeMs > MAX_BREAKOUT_LIFETIME_MS) fail("invalid_breakout_lifetime");
    if (!Number.isSafeInteger(now) || now < 0) fail("invalid_breakout_time");

    const occupied = new Set(occupiedRoomIds);
    occupied.add(parentRoomId);
    for (const roomId of this.#byChild.keys()) occupied.add(roomId);

    const children = [];
    for (let index = 0; index < childCount; index += 1) {
      const roomId = allocateChildRoomId(occupied);
      occupied.add(roomId);
      const child = {
        childId: crypto.randomBytes(8).toString("hex"),
        roomId,
        state: "open",
        capacity,
        membershipEpoch: 1,
        topologyEpoch: 1,
        routeEpoch: 1,
        securityEpoch: 1,
        createdAt: now,
        expiresAt: now + lifetimeMs,
      };
      children.push(child);
      this.#byChild.set(roomId, parentRoomId);
    }

    this.#sets.set(parentRoomId, {
      setId: crypto.randomBytes(8).toString("hex"),
      parentRoomId,
      parentRevision: 1,
      state: "open",
      createdAt: now,
      expiresAt: now + lifetimeMs,
      children,
    });
    return this.snapshot(parentRoomId);
  }

  reserved(roomId) {
    const parentRoomId = this.#byChild.get(roomId);
    if (!parentRoomId) return null;
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state === "closed") return null;
    const child = set.children.find((item) => item.roomId === roomId);
    if (!child || child.state !== "open") return null;
    return Object.freeze({
      setId: set.setId,
      parentRoomId,
      parentRevision: set.parentRevision,
      childId: child.childId,
      childRoomId: child.roomId,
      capacity: child.capacity,
      state: child.state,
      membershipEpoch: child.membershipEpoch,
      topologyEpoch: child.topologyEpoch,
      routeEpoch: child.routeEpoch,
      securityEpoch: child.securityEpoch,
      expiresAt: child.expiresAt,
    });
  }

  mayJoinChild({ roomId, setId, now = Date.now() }) {
    const reserved = this.reserved(roomId);
    if (!reserved || reserved.setId !== setId) fail("breakout_assignment_required");
    if (reserved.expiresAt <= now) fail("breakout_expired");
    return reserved;
  }

  snapshot(parentRoomId) {
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state === "closed") return null;
    return Object.freeze({
      type: "breakout-set",
      setId: set.setId,
      parentRoomId: set.parentRoomId,
      parentRevision: set.parentRevision,
      state: set.state,
      expiresAt: set.expiresAt,
      children: Object.freeze(set.children.filter((child) => child.state !== "closed").map(freezeChild)),
    });
  }

  closeSet(parentRoomId, now = Date.now()) {
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state === "closed") return null;
    set.state = "closed";
    set.parentRevision += 1;
    const childRoomIds = [];
    for (const child of set.children) {
      child.state = "closed";
      child.membershipEpoch += 1;
      child.topologyEpoch += 1;
      child.routeEpoch += 1;
      child.securityEpoch += 1;
      this.#byChild.delete(child.roomId);
      childRoomIds.push(child.roomId);
    }
    this.#sets.delete(parentRoomId);
    return Object.freeze({ setId: set.setId, parentRoomId, closedAt: now, childRoomIds: Object.freeze(childRoomIds) });
  }

  due(now = Date.now()) {
    return [...this.#sets.entries()]
      .filter(([, set]) => set.expiresAt <= now)
      .map(([parentRoomId]) => parentRoomId);
  }

  parentOf(roomId) {
    return this.#byChild.get(roomId) || "";
  }

  isChildRoom(roomId) {
    return this.#byChild.has(roomId);
  }

  childRoomIds() {
    return [...this.#byChild.keys()];
  }
}
