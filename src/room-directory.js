import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOM_VISIBILITIES = new Set(["private", "public"]);
const MAX_ROOM_TITLE_LENGTH = 80;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OWNER_PRINCIPAL_LENGTH = 512;
const SCHEMA_VERSION = 1;
const PINNED_ROOM_ID_PATTERN = /^room-[a-f0-9]{18}$/;
const MAX_PINNED_ROOMS = 16;
const PINNED_ROOM_FIELDS = new Set(["roomId", "title", "visibility", "ownerPrincipal"]);

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

/**
 * Operator-pinned directory entries: restored with their exact room id at every
 * start and never idle-pruned. Only the operator configuration can name a room
 * id here; the HTTP API keeps generating ids server-side.
 */
export function normalizePinnedRooms(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_PINNED_ROOMS) throw new Error("room_directory_pins_invalid");
  const seen = new Set();
  return Object.freeze(value.map((pin) => {
    if (!pin || typeof pin !== "object" || Array.isArray(pin)
      || Object.keys(pin).some((key) => !PINNED_ROOM_FIELDS.has(key))) {
      throw new Error("room_directory_pins_invalid");
    }
    const owner = typeof pin.ownerPrincipal === "string" ? pin.ownerPrincipal : "";
    const separator = owner.lastIndexOf("|");
    if (typeof pin.roomId !== "string" || !PINNED_ROOM_ID_PATTERN.test(pin.roomId) || seen.has(pin.roomId)
      || separator < 1 || separator === owner.length - 1 || owner.length > MAX_OWNER_PRINCIPAL_LENGTH) {
      throw new Error("room_directory_pins_invalid");
    }
    seen.add(pin.roomId);
    try {
      return Object.freeze({
        roomId: pin.roomId,
        title: normalizeRoomTitle(pin.title),
        visibility: normalizeRoomVisibility(pin.visibility, "public"),
        ownerPrincipal: owner,
      });
    } catch {
      throw new Error("room_directory_pins_invalid");
    }
  }));
}

/**
 * Directory metadata (title, visibility, owner) survives a restart only when a
 * store file is configured. Membership, peer ids and media stay volatile; the
 * store holds exactly the rows the in-memory map holds (write-through).
 */
class RoomDirectoryStore {
  #database;

  constructor(filename) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = this.#database.prepare("PRAGMA user_version").get().user_version;
    if (version > SCHEMA_VERSION) throw new Error("room_directory_schema_unsupported");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS room_directory (
        room_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        visibility TEXT NOT NULL,
        owner_principal TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  load() {
    return this.#database.prepare(`
      SELECT room_id, title, visibility, owner_principal, created_at, updated_at FROM room_directory
    `).all();
  }

  save(entry, { owner = false } = {}) {
    this.#database.prepare(`
      INSERT INTO room_directory (room_id, title, visibility, owner_principal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET title = excluded.title, visibility = excluded.visibility,
        updated_at = excluded.updated_at${owner ? ", owner_principal = excluded.owner_principal" : ""}
    `).run(entry.roomId, entry.title, entry.visibility, entry.ownerPrincipal, entry.createdAt, entry.updatedAt);
  }

  remove(roomIds) {
    const statement = this.#database.prepare("DELETE FROM room_directory WHERE room_id = ?");
    for (const roomId of roomIds) statement.run(roomId);
  }

  close() {
    this.#database.close();
  }
}

function restoredEntry(row) {
  // A tampered or foreign row is skipped rather than trusted: the directory
  // never publishes metadata the create/update path would have refused.
  try {
    if (!ROOM_ID_PATTERN.test(String(row.room_id))) return null;
    if (typeof row.owner_principal !== "string" || !row.owner_principal
      || row.owner_principal.length > MAX_OWNER_PRINCIPAL_LENGTH) return null;
    const createdAt = Number(row.created_at);
    const updatedAt = Number(row.updated_at);
    if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) return null;
    return {
      roomId: row.room_id,
      title: normalizeRoomTitle(row.title),
      visibility: normalizeRoomVisibility(row.visibility),
      ownerPrincipal: row.owner_principal,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export class RoomDirectory {
  #entries = new Map();
  #idleTtlMs;
  #maxParticipants;
  #maxEntriesPerOwner;
  #pinned = new Set();
  #store = null;

  constructor({
    idleTtlMs = 3_600_000,
    maxParticipants = 20,
    maxEntriesPerOwner = 100,
    filename = "",
    pinned = [],
    now = Date.now(),
  } = {}) {
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1_000) {
      throw new RangeError("idleTtlMs must be at least 1000");
    }
    if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 20) {
      throw new RangeError("maxParticipants must be between 2 and 20");
    }
    if (!Number.isSafeInteger(maxEntriesPerOwner) || maxEntriesPerOwner < 1 || maxEntriesPerOwner > 1_000) {
      throw new RangeError("maxEntriesPerOwner must be between 1 and 1000");
    }
    this.#idleTtlMs = idleTtlMs;
    this.#maxParticipants = maxParticipants;
    this.#maxEntriesPerOwner = maxEntriesPerOwner;
    const pins = normalizePinnedRooms(pinned);
    if (filename) {
      this.#store = new RoomDirectoryStore(filename);
      this.#restore(now);
    }
    for (const pin of pins) this.#pin(pin, now);
  }

  #pin(pin, now) {
    // The operator pin decides the owner; title and visibility stay with that
    // owner once the entry exists, so a later PATCH is not undone on restart.
    const current = this.#entries.get(pin.roomId);
    const entry = current
      ? { ...current, ownerPrincipal: pin.ownerPrincipal, updatedAt: Math.max(current.updatedAt, now) }
      : { ...pin, createdAt: now, updatedAt: now };
    this.#store?.save(entry, { owner: true });
    this.#entries.set(pin.roomId, entry);
    this.#pinned.add(pin.roomId);
  }

  #restore(now) {
    const dropped = [];
    const restored = [];
    for (const row of this.#store.load()) {
      const entry = restoredEntry(row);
      if (!entry) {
        dropped.push(String(row.room_id));
        continue;
      }
      // A restart is no evidence of idleness: members reconnect after it, so
      // the idle clock restarts instead of pruning every entry on first sight.
      entry.updatedAt = Math.max(entry.updatedAt, now);
      this.#entries.set(entry.roomId, entry);
      restored.push(entry);
    }
    this.#store.remove(dropped);
    for (const entry of restored) this.#store.save(entry);
  }

  #ownerCount(ownerPrincipal) {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.ownerPrincipal === ownerPrincipal) count += 1;
    return count;
  }

  create({ roomId, title, visibility, ownerPrincipal }, now = Date.now()) {
    if (!roomId || !ownerPrincipal) throw new RoomDirectoryError("room_owner_required", 401);
    if (!ROOM_ID_PATTERN.test(roomId) || ownerPrincipal.length > MAX_OWNER_PRINCIPAL_LENGTH) {
      throw new RoomDirectoryError("invalid_room_id");
    }
    if (this.#entries.has(roomId)) throw new RoomDirectoryError("room_already_registered", 409);
    if (this.#ownerCount(ownerPrincipal) >= this.#maxEntriesPerOwner) {
      throw new RoomDirectoryError("room_directory_owner_limit", 429);
    }
    const entry = {
      roomId,
      title: normalizeRoomTitle(title),
      visibility: normalizeRoomVisibility(visibility),
      ownerPrincipal,
      createdAt: now,
      updatedAt: now,
    };
    this.#store?.save(entry);
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
    const next = { ...entry, updatedAt: now };
    if (changes.title !== undefined) next.title = normalizeRoomTitle(changes.title);
    if (changes.visibility !== undefined) {
      next.visibility = normalizeRoomVisibility(changes.visibility);
    }
    this.#store?.save(next);
    Object.assign(entry, next);
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
    this.#store?.save(entry);
    return true;
  }

  prune(now = Date.now(), isActive = () => false) {
    const removed = [];
    for (const [roomId, entry] of this.#entries) {
      if (this.#pinned.has(roomId)) continue;
      if (!isActive(roomId) && now - entry.updatedAt >= this.#idleTtlMs) removed.push(roomId);
    }
    this.#store?.remove(removed);
    for (const roomId of removed) this.#entries.delete(roomId);
    return removed.length;
  }

  close() {
    this.#store?.close();
    this.#store = null;
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
