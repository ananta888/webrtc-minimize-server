import crypto from "node:crypto";

import { ROOM_ID_PATTERN } from "./protocol.js";
import { MAX_ROOM_PARTICIPANTS, MIN_ROOM_PARTICIPANTS } from "./room-limits.js";

export const MAX_BREAKOUT_CHILDREN = 10;
export const MIN_BREAKOUT_CHILDREN = 1;
export const MIN_BREAKOUT_LIFETIME_MS = 60_000;
export const MAX_BREAKOUT_LIFETIME_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_BREAKOUT_LIFETIME_MS = 20 * 60 * 1000;
export const MIN_BREAKOUT_GRANT_MS = 15_000;
export const MAX_BREAKOUT_GRANT_MS = 15 * 60 * 1000;
export const DEFAULT_BREAKOUT_GRANT_MS = 120_000;

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

function liveGrant(grant, now) {
  return grant.consumedAt === 0 && grant.expiresAt > now;
}

function freezeGrant(grant) {
  return Object.freeze({
    grantId: grant.grantId,
    setId: grant.setId,
    childRoomId: grant.childRoomId,
    targetPeerId: grant.targetPeerId,
    parentRevision: grant.parentRevision,
    expiresAt: grant.expiresAt,
    consumed: grant.consumedAt > 0,
  });
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
      grants: [],
    });
    return this.snapshot(parentRoomId, now);
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

  assign({
    parentRoomId, ownerRole, targetPeer, childRoomId,
    ttlMs = DEFAULT_BREAKOUT_GRANT_MS, now = Date.now(), occupied = 0,
  }) {
    if (ownerRole !== "owner") fail("breakout_owner_required");
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state !== "open") fail("breakout_unavailable");
    if (set.expiresAt <= now) fail("breakout_expired");
    if (!targetPeer || targetPeer.roomId !== parentRoomId) fail("breakout_target_not_member");
    if (targetPeer.machine === true) fail("breakout_machine_denied");
    if (typeof targetPeer.principal !== "string" || targetPeer.principal.length < 1) fail("invalid_breakout_principal");
    if (typeof targetPeer.deviceFingerprint !== "string" || targetPeer.deviceFingerprint.length < 8) {
      fail("invalid_breakout_device");
    }
    const child = set.children.find((item) => item.roomId === childRoomId && item.state === "open");
    if (!child) fail("breakout_unknown_child");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_BREAKOUT_GRANT_MS || ttlMs > MAX_BREAKOUT_GRANT_MS) {
      fail("invalid_breakout_grant");
    }
    if (!Number.isSafeInteger(occupied) || occupied < 0) fail("invalid_breakout_occupancy");
    const expiresAt = Math.min(now + ttlMs, set.expiresAt);
    if (expiresAt <= now) fail("breakout_expired");
    set.grants = set.grants.filter((grant) => !(liveGrant(grant, now)
      && grant.principal === targetPeer.principal
      && grant.deviceFingerprint === targetPeer.deviceFingerprint));
    const waiting = set.grants.filter((grant) => liveGrant(grant, now) && grant.childRoomId === childRoomId).length;
    if (waiting + occupied >= child.capacity) fail("breakout_child_full");
    const grant = {
      grantId: crypto.randomBytes(8).toString("hex"),
      setId: set.setId,
      parentRoomId,
      parentRevision: set.parentRevision,
      childRoomId,
      principal: targetPeer.principal,
      deviceFingerprint: targetPeer.deviceFingerprint,
      targetPeerId: targetPeer.id,
      expiresAt,
      consumedAt: 0,
    };
    set.grants.push(grant);
    return freezeGrant(grant);
  }

  assignBalanced({
    parentRoomId, ownerRole, candidatePeers,
    ttlMs = DEFAULT_BREAKOUT_GRANT_MS, now = Date.now(), occupiedByChild = new Map(),
  }) {
    if (ownerRole !== "owner") fail("breakout_owner_required");
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state !== "open") fail("breakout_unavailable");
    if (set.expiresAt <= now) fail("breakout_expired");
    const openChildren = set.children.filter((child) => child.state === "open");
    if (openChildren.length === 0) fail("breakout_unknown_child");

    const eligiblePeers = (candidatePeers || []).filter((peer) =>
      peer && peer.roomId === parentRoomId && peer.machine !== true
      && typeof peer.principal === "string" && peer.principal.length > 0
      && typeof peer.deviceFingerprint === "string" && peer.deviceFingerprint.length >= 8
    );

    eligiblePeers.sort((a, b) => a.id.localeCompare(b.id));
    openChildren.sort((a, b) => a.roomId.localeCompare(b.roomId));

    const candidateKeys = new Set(eligiblePeers.map((p) => `${p.principal}\0${p.deviceFingerprint}`));
    set.grants = set.grants.filter((grant) => !(liveGrant(grant, now)
      && candidateKeys.has(`${grant.principal}\0${grant.deviceFingerprint}`)));

    const grants = [];
    let childIndex = 0;
    const initialChildrenCount = openChildren.length;

    for (const peer of eligiblePeers) {
      let assigned = false;
      for (let attempt = 0; attempt < initialChildrenCount; attempt += 1) {
        const child = openChildren[(childIndex + attempt) % initialChildrenCount];
        const occupied = Number(occupiedByChild.get?.(child.roomId) ?? occupiedByChild[child.roomId] ?? 0);
        const waiting = set.grants.filter((g) => liveGrant(g, now) && g.childRoomId === child.roomId
          && !(g.principal === peer.principal && g.deviceFingerprint === peer.deviceFingerprint)).length;
        if (waiting + occupied < child.capacity) {
          const grant = this.assign({
            parentRoomId,
            ownerRole,
            targetPeer: peer,
            childRoomId: child.roomId,
            ttlMs,
            now,
            occupied,
          });
          grants.push(grant);
          childIndex = (childIndex + attempt + 1) % initialChildrenCount;
          assigned = true;
          break;
        }
      }
      if (!assigned) break;
    }
    return Object.freeze(grants);
  }

  assignVoluntary({
    parentRoomId, targetPeer, childRoomId,
    ttlMs = DEFAULT_BREAKOUT_GRANT_MS, now = Date.now(), occupied = 0,
  }) {
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state !== "open") fail("breakout_unavailable");
    if (set.expiresAt <= now) fail("breakout_expired");
    if (!targetPeer || targetPeer.roomId !== parentRoomId) fail("breakout_target_not_member");
    if (targetPeer.machine === true) fail("breakout_machine_denied");
    if (typeof targetPeer.principal !== "string" || targetPeer.principal.length < 1) fail("invalid_breakout_principal");
    if (typeof targetPeer.deviceFingerprint !== "string" || targetPeer.deviceFingerprint.length < 8) {
      fail("invalid_breakout_device");
    }
    const child = set.children.find((item) => item.roomId === childRoomId && item.state === "open");
    if (!child) fail("breakout_unknown_child");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_BREAKOUT_GRANT_MS || ttlMs > MAX_BREAKOUT_GRANT_MS) {
      fail("invalid_breakout_grant");
    }
    if (!Number.isSafeInteger(occupied) || occupied < 0) fail("invalid_breakout_occupancy");
    const expiresAt = Math.min(now + ttlMs, set.expiresAt);
    if (expiresAt <= now) fail("breakout_expired");

    set.grants = set.grants.filter((grant) => !(liveGrant(grant, now)
      && grant.principal === targetPeer.principal
      && grant.deviceFingerprint === targetPeer.deviceFingerprint));
    const waiting = set.grants.filter((grant) => liveGrant(grant, now) && grant.childRoomId === childRoomId).length;
    if (waiting + occupied >= child.capacity) fail("breakout_child_full");

    const grant = {
      grantId: crypto.randomBytes(8).toString("hex"),
      setId: set.setId,
      parentRoomId,
      parentRevision: set.parentRevision,
      childRoomId,
      principal: targetPeer.principal,
      deviceFingerprint: targetPeer.deviceFingerprint,
      targetPeerId: targetPeer.id,
      expiresAt,
      consumedAt: 0,
    };
    set.grants.push(grant);
    return freezeGrant(grant);
  }

  resolveAssignment({
    parentRoomId, targetPeer, preferredChildRoomId,
    ttlMs = DEFAULT_BREAKOUT_GRANT_MS, now = Date.now(), occupiedByChild = new Map(),
  }) {
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state !== "open") fail("breakout_unavailable");
    if (set.expiresAt <= now) fail("breakout_expired");
    const openChildren = set.children.filter((child) => child.state === "open");
    if (openChildren.length === 0) fail("breakout_unknown_child");

    if (preferredChildRoomId) {
      const preferred = openChildren.find((c) => c.roomId === preferredChildRoomId);
      if (preferred) {
        const occupied = Number(occupiedByChild.get?.(preferred.roomId) ?? occupiedByChild[preferred.roomId] ?? 0);
        const waiting = set.grants.filter((g) => liveGrant(g, now) && g.childRoomId === preferred.roomId
          && !(g.principal === targetPeer?.principal && g.deviceFingerprint === targetPeer?.deviceFingerprint)).length;
        if (waiting + occupied < preferred.capacity) {
          return this.assignVoluntary({
            parentRoomId,
            targetPeer,
            childRoomId: preferred.roomId,
            ttlMs,
            now,
            occupied,
          });
        }
      }
    }

    const scored = openChildren.map((child) => {
      const occupied = Number(occupiedByChild.get?.(child.roomId) ?? occupiedByChild[child.roomId] ?? 0);
      const waiting = set.grants.filter((g) => liveGrant(g, now) && g.childRoomId === child.roomId
        && !(g.principal === targetPeer?.principal && g.deviceFingerprint === targetPeer?.deviceFingerprint)).length;
      return { child, remaining: child.capacity - (waiting + occupied), occupied };
    }).filter((item) => item.remaining > 0);

    if (scored.length === 0) fail("breakout_all_children_full");
    scored.sort((a, b) => b.remaining - a.remaining || a.child.roomId.localeCompare(b.child.roomId));

    return this.assignVoluntary({
      parentRoomId,
      targetPeer,
      childRoomId: scored[0].child.roomId,
      ttlMs,
      now,
      occupied: scored[0].occupied,
    });
  }

  revoke({ parentRoomId, ownerRole, grantId, now = Date.now() }) {
    if (ownerRole !== "owner") fail("breakout_owner_required");
    const set = this.#sets.get(parentRoomId);
    if (!set || set.state !== "open") fail("breakout_unavailable");
    const index = (set.grants || []).findIndex((grant) => grant.grantId === grantId);
    if (index < 0) fail("breakout_unknown_grant");
    const grant = set.grants[index];
    if (!liveGrant(grant, now)) fail("breakout_grant_consumed");
    set.grants.splice(index, 1);
    grant.consumedAt = now;
    return freezeGrant(grant);
  }

  hasLiveGrant({ roomId, principal, deviceFingerprint, now = Date.now() }) {
    const reserved = this.reserved(roomId);
    if (!reserved) return false;
    const set = this.#sets.get(reserved.parentRoomId);
    return (set?.grants || []).some((grant) => liveGrant(grant, now)
      && grant.childRoomId === roomId
      && grant.principal === principal
      && grant.deviceFingerprint === deviceFingerprint
      && grant.parentRevision === set.parentRevision);
  }

  consume({ roomId, setId, principal, deviceFingerprint, now = Date.now() }) {
    const reserved = this.reserved(roomId);
    if (!reserved || reserved.setId !== setId) fail("breakout_assignment_required");
    if (reserved.expiresAt <= now) fail("breakout_expired");
    const set = this.#sets.get(reserved.parentRoomId);
    const grant = (set?.grants || []).find((item) => liveGrant(item, now)
      && item.childRoomId === roomId
      && item.setId === setId
      && item.principal === principal
      && item.deviceFingerprint === deviceFingerprint
      && item.parentRevision === set.parentRevision);
    if (!grant) fail("breakout_assignment_required");
    grant.consumedAt = now;
    return reserved;
  }

  snapshot(parentRoomId, now = Date.now()) {
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
      grants: Object.freeze((set.grants || []).filter((grant) => liveGrant(grant, now)).map(freezeGrant)),
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
