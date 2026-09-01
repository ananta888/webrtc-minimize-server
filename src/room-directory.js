const ROOM_VISIBILITIES = new Set(["private", "public"]);
const MAX_ROOM_TITLE_LENGTH = 80;

export class RoomDirectoryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function normalizeRoomVisibility(value, fallback = "private") {
  if (value !== undefined && typeof value !== "string") {
    throw new RoomDirectoryError("invalid_room_visibility");
  }
  const visibility = value === undefined ? fallback : value;
  if (!ROOM_VISIBILITIES.has(visibility)) {
    throw new RoomDirectoryError("invalid_room_visibility");
  }
  return visibility;
}

export function normalizeRoomTitle(value, fallback = "Neuer Raum") {
  if (value !== undefined && typeof value !== "string") {
    throw new RoomDirectoryError("invalid_room_title");
  }
  const rawTitle = value === undefined ? fallback : value;
  if (/[\u0000-\u001f\u007f]/u.test(rawTitle)) {
    throw new RoomDirectoryError("invalid_room_title");
  }
  const title = rawTitle.trim().replace(/\s+/gu, " ");
  if (!title || title.length > MAX_ROOM_TITLE_LENGTH) {
    throw new RoomDirectoryError("invalid_room_title");
  }
  return title;
}

export class RoomDirectory {
  #entries = new Map();
  #idleTtlMs;
  #maxParticipants;

  constructor({ idleTtlMs = 3_600_000, maxParticipants = 20 } = {}) {
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1_000) {
      throw new RangeError("idleTtlMs must be at least 1000");
    }
    if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 20) {
      throw new RangeError("maxParticipants must be between 2 and 20");
    }
    this.#idleTtlMs = idleTtlMs;
    this.#maxParticipants = maxParticipants;
  }

  create({ roomId, title, visibility, ownerPrincipal }, now = Date.now()) {
    if (!roomId || !ownerPrincipal) throw new RoomDirectoryError("room_owner_required", 401);
    if (this.#entries.has(roomId)) throw new RoomDirectoryError("room_already_registered", 409);
    const entry = {
      roomId,
      title: normalizeRoomTitle(title),
      visibility: normalizeRoomVisibility(visibility),
      ownerPrincipal,
      createdAt: now,
      updatedAt: now,
    };
    this.#entries.set(roomId, entry);
    return this.#summary(entry, ownerPrincipal, () => 0);
  }

  update(roomId, ownerPrincipal, changes, now = Date.now()) {
    const entry = this.#entries.get(roomId);
    if (!entry) throw new RoomDirectoryError("room_not_found", 404);
    if (!ownerPrincipal || entry.ownerPrincipal !== ownerPrincipal) {
      throw new RoomDirectoryError("room_owner_required", 403);
    }
    if (!changes || (changes.title === undefined && changes.visibility === undefined)) {
      throw new RoomDirectoryError("empty_room_update");
    }
    if (changes.title !== undefined) entry.title = normalizeRoomTitle(changes.title);
    if (changes.visibility !== undefined) {
      entry.visibility = normalizeRoomVisibility(changes.visibility);
    }
    entry.updatedAt = now;
    return this.#summary(entry, ownerPrincipal, () => 0);
  }

  ownerPrincipal(roomId) {
    return this.#entries.get(roomId)?.ownerPrincipal || "";
  }

  list({ principal = "", participantCount = () => 0 } = {}) {
    const entries = [...this.#entries.values()].sort((left, right) => (
      right.updatedAt - left.updatedAt || left.roomId.localeCompare(right.roomId)
    ));
    return {
      publicRooms: entries
        .filter((entry) => entry.visibility === "public")
        .map((entry) => this.#summary(entry, principal, participantCount)),
      ownRooms: principal
        ? entries
          .filter((entry) => entry.ownerPrincipal === principal)
          .map((entry) => this.#summary(entry, principal, participantCount))
        : [],
    };
  }

  touch(roomId, now = Date.now()) {
    const entry = this.#entries.get(roomId);
    if (!entry) return false;
    entry.updatedAt = now;
    return true;
  }

  prune(now = Date.now(), isActive = () => false) {
    let removed = 0;
    for (const [roomId, entry] of this.#entries) {
      if (!isActive(roomId) && now - entry.updatedAt >= this.#idleTtlMs) {
        this.#entries.delete(roomId);
        removed += 1;
      }
    }
    return removed;
  }

  get roomCount() {
    return this.#entries.size;
  }

  #summary(entry, principal, participantCount) {
    const count = Number(participantCount(entry.roomId));
    return {
      roomId: entry.roomId,
      title: entry.title,
      visibility: entry.visibility,
      participantCount: Number.isSafeInteger(count) && count >= 0 ? count : 0,
      maxParticipants: this.#maxParticipants,
      owned: Boolean(principal) && entry.ownerPrincipal === principal,
      createdAt: new Date(entry.createdAt).toISOString(),
      updatedAt: new Date(entry.updatedAt).toISOString(),
    };
  }
}
