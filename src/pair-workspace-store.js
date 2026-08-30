import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const EVENT_KINDS = new Set(["note", "decision", "task", "artifact", "system"]);
const PRESENCE_STATES = new Set(["active", "away", "offline"]);

export class PairWorkspaceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "PairWorkspaceError";
    this.code = code;
    this.status = status;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function requireToken(value, name) {
  const token = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw new PairWorkspaceError(`invalid_${name}`);
  return token;
}

function normalizeTitle(value) {
  const title = String(value || "Pair Workspace").trim().replace(/\s+/g, " ");
  if (title.length < 1 || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new PairWorkspaceError("invalid_workspace_title");
  }
  return title;
}

function tenantOf(principal) {
  const separator = String(principal).lastIndexOf("|");
  if (separator < 1) throw new PairWorkspaceError("invalid_principal", 403);
  return principal.slice(0, separator);
}

export class PairWorkspaceStore {
  #database;

  constructor({ filename = ":memory:" } = {}) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  create({ roomId, title, ownerPrincipal, now = Date.now() }) {
    requireToken(roomId, "room_id");
    if (!ownerPrincipal) throw new PairWorkspaceError("authentication_required", 401);
    const workspaceId = crypto.randomUUID();
    const inviteToken = crypto.randomBytes(32).toString("base64url");
    const normalizedTitle = normalizeTitle(title);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO workspaces (id, room_id, title, owner_principal, tenant_id, membership_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(workspaceId, roomId, normalizedTitle, ownerPrincipal, tenantOf(ownerPrincipal), now, now);
      this.#database.prepare(`
        INSERT INTO memberships (workspace_id, principal, role, created_at)
        VALUES (?, ?, 'owner', ?)
      `).run(workspaceId, ownerPrincipal, now);
      this.#database.prepare(`
        INSERT INTO invites (token_hash, workspace_id, role, uses, max_uses, expires_at)
        VALUES (?, ?, 'editor', 0, 1, ?)
      `).run(digest(inviteToken), workspaceId, now + 7 * 24 * 60 * 60 * 1000);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { workspaceId, roomId, title: normalizedTitle, role: "owner", inviteToken };
  }

  admit(roomId, principal, inviteToken = "", now = Date.now()) {
    const workspace = this.#database.prepare("SELECT * FROM workspaces WHERE room_id = ?").get(roomId);
    if (!workspace) return null;
    if (!principal) throw new PairWorkspaceError("authentication_required", 401);
    if (tenantOf(principal) !== workspace.tenant_id) throw new PairWorkspaceError("workspace_not_found", 404);
    const existing = this.#database.prepare(`
      SELECT role FROM memberships WHERE workspace_id = ? AND principal = ?
    `).get(workspace.id, principal);
    if (existing) return { workspaceId: workspace.id, role: existing.role };
    if (!inviteToken) throw new PairWorkspaceError("workspace_membership_required", 403);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const invitation = this.#database.prepare(`
        SELECT * FROM invites WHERE token_hash = ? AND workspace_id = ?
          AND uses < max_uses AND expires_at >= ?
      `).get(digest(inviteToken), workspace.id, now);
      if (!invitation) throw new PairWorkspaceError("invalid_workspace_invite", 403);
      const count = this.#database.prepare(
        "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id = ?",
      ).get(workspace.id).count;
      if (count >= 2) throw new PairWorkspaceError("workspace_full", 409);
      this.#database.prepare(`
        INSERT INTO memberships (workspace_id, principal, role, created_at) VALUES (?, ?, ?, ?)
      `).run(workspace.id, principal, invitation.role, now);
      this.#database.prepare(`
        UPDATE workspaces SET membership_revision = membership_revision + 1, updated_at = ? WHERE id = ?
      `).run(now, workspace.id);
      this.#database.prepare("UPDATE invites SET uses = uses + 1 WHERE token_hash = ?").run(digest(inviteToken));
      this.#database.exec("COMMIT");
      return { workspaceId: workspace.id, role: invitation.role };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  list(principal) {
    if (!principal) throw new PairWorkspaceError("authentication_required", 401);
    return this.#database.prepare(`
      SELECT w.id AS workspaceId, w.room_id AS roomId, w.title, m.role,
        w.membership_revision AS membershipRevision, w.created_at AS createdAt, w.updated_at AS updatedAt
      FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
      WHERE m.principal = ? ORDER BY w.updated_at DESC
    `).all(principal);
  }

  get(workspaceId, principal, now = Date.now()) {
    const membership = this.#membership(workspaceId, principal);
    const workspace = this.#database.prepare(`
      SELECT id AS workspaceId, room_id AS roomId, title, membership_revision AS membershipRevision,
        created_at AS createdAt, updated_at AS updatedAt
      FROM workspaces WHERE id = ?
    `).get(workspaceId);
    const members = this.#database.prepare(`
      SELECT principal, role, created_at AS createdAt FROM memberships WHERE workspace_id = ? ORDER BY created_at
    `).all(workspaceId);
    const presence = this.#database.prepare(`
      SELECT principal, state, document_id AS documentId, line, column, lease_id AS leaseId,
        epoch, expires_at AS expiresAt, updated_at AS updatedAt
      FROM presence WHERE workspace_id = ? AND expires_at > ? ORDER BY principal
    `).all(workspaceId, now);
    return { ...workspace, role: membership.role, members, presence };
  }

  appendEvent(workspaceId, principal, input, now = Date.now()) {
    const membership = this.#membership(workspaceId, principal);
    if (!new Set(["owner", "editor"]).has(membership.role)) {
      throw new PairWorkspaceError("workspace_write_denied", 403);
    }
    const eventId = requireToken(input.eventId, "event_id");
    const kind = String(input.kind || "");
    if (!EVENT_KINDS.has(kind)) throw new PairWorkspaceError("invalid_event_kind");
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new PairWorkspaceError("invalid_event_payload");
    }
    const payloadJson = stableJson(input.payload);
    if (Buffer.byteLength(payloadJson) > 16 * 1024) throw new PairWorkspaceError("event_payload_too_large");
    const correlationId = input.correlationId ? requireToken(input.correlationId, "correlation_id") : eventId;
    const eventDigest = digest(`1\0${workspaceId}\0${eventId}\0${correlationId}\0${kind}\0${payloadJson}`);
    const existing = this.#database.prepare(`
      SELECT sequence, digest FROM events WHERE workspace_id = ? AND event_id = ?
    `).get(workspaceId, eventId);
    if (existing) {
      if (existing.digest !== eventDigest) throw new PairWorkspaceError("event_id_conflict", 409);
      return { sequence: existing.sequence, eventId, digest: eventDigest, idempotent: true };
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#database.prepare(`
        INSERT INTO events (workspace_id, event_id, correlation_id, actor_principal, kind, payload_json, digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(workspaceId, eventId, correlationId, principal, kind, payloadJson, eventDigest, now);
      const sequence = Number(inserted.lastInsertRowid);
      this.#database.prepare(`
        INSERT INTO outbox (workspace_id, event_sequence, state, created_at) VALUES (?, ?, 'pending', ?)
      `).run(workspaceId, sequence, now);
      this.#database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, workspaceId);
      this.#database.exec("COMMIT");
      return { sequence, eventId, digest: eventDigest, idempotent: false };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  timeline(workspaceId, principal, { after = 0, limit = 100 } = {}) {
    this.#membership(workspaceId, principal);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new PairWorkspaceError("invalid_timeline_cursor");
    }
    return this.#database.prepare(`
      SELECT e.sequence, e.event_id AS eventId, e.correlation_id AS correlationId,
        e.actor_principal AS actorPrincipal, e.kind, e.payload_json AS payloadJson, e.digest,
        e.created_at AS createdAt, w.room_id AS roomId
      FROM events e JOIN workspaces w ON w.id = e.workspace_id
      WHERE e.workspace_id = ? AND e.sequence > ? ORDER BY e.sequence LIMIT ?
    `).all(workspaceId, after, limit).map((event) => ({
      version: 1,
      workspaceId,
      ...event,
      payload: JSON.parse(event.payloadJson),
      payloadJson: undefined,
    }));
  }

  setCursor(workspaceId, principal, sequence, now = Date.now()) {
    this.#membership(workspaceId, principal);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new PairWorkspaceError("invalid_cursor");
    if (sequence > 0 && !this.#database.prepare(
      "SELECT 1 FROM events WHERE workspace_id = ? AND sequence = ?",
    ).get(workspaceId, sequence)) throw new PairWorkspaceError("cursor_event_missing");
    const current = this.#database.prepare(`
      SELECT event_sequence AS sequence FROM cursors WHERE workspace_id = ? AND principal = ?
    `).get(workspaceId, principal);
    if (current && sequence < current.sequence) throw new PairWorkspaceError("cursor_regression", 409);
    this.#database.prepare(`
      INSERT INTO cursors (workspace_id, principal, event_sequence, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, principal) DO UPDATE SET event_sequence=excluded.event_sequence, updated_at=excluded.updated_at
    `).run(workspaceId, principal, sequence, now);
    return { sequence, updatedAt: now };
  }

  setPresence(workspaceId, principal, input, now = Date.now()) {
    this.#membership(workspaceId, principal);
    const state = String(input.state || "");
    const documentId = String(input.documentId || "");
    const line = Number(input.line ?? 0);
    const column = Number(input.column ?? 0);
    const leaseId = requireToken(input.leaseId, "presence_lease");
    const epoch = Number(input.epoch);
    const ttlMs = Number(input.ttlMs);
    if (!PRESENCE_STATES.has(state) || documentId.length > 160
      || !Number.isSafeInteger(line) || line < 0 || line > 10_000_000
      || !Number.isSafeInteger(column) || column < 0 || column > 1_000_000
      || !Number.isSafeInteger(epoch) || epoch < 1
      || !Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 60_000) {
      throw new PairWorkspaceError("invalid_presence");
    }
    const current = this.#database.prepare(`
      SELECT epoch FROM presence WHERE workspace_id = ? AND principal = ?
    `).get(workspaceId, principal);
    if (current && epoch <= current.epoch) throw new PairWorkspaceError("stale_presence_epoch", 409);
    this.#database.prepare(`
      INSERT INTO presence (workspace_id, principal, state, document_id, line, column, lease_id, epoch, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, principal) DO UPDATE SET state=excluded.state, document_id=excluded.document_id,
        line=excluded.line, column=excluded.column, lease_id=excluded.lease_id, epoch=excluded.epoch,
        expires_at=excluded.expires_at, updated_at=excluded.updated_at
    `).run(workspaceId, principal, state, documentId, line, column, leaseId, epoch, now + ttlMs, now);
    return { state, documentId, line, column, leaseId, epoch, expiresAt: now + ttlMs, updatedAt: now };
  }

  setRole(workspaceId, ownerPrincipal, targetPrincipal, role, expectedRevision, now = Date.now()) {
    const membership = this.#membership(workspaceId, ownerPrincipal);
    if (membership.role !== "owner") throw new PairWorkspaceError("workspace_owner_required", 403);
    if (!new Set(["editor", "viewer", "revoked"]).has(role) || !targetPrincipal || targetPrincipal === ownerPrincipal
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new PairWorkspaceError("invalid_workspace_role");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const revision = this.#database.prepare(`
        UPDATE workspaces SET membership_revision = membership_revision + 1, updated_at = ?
        WHERE id = ? AND membership_revision = ?
      `).run(now, workspaceId, expectedRevision);
      if (revision.changes !== 1) throw new PairWorkspaceError("membership_revision_conflict", 409);
      const result = role === "revoked"
        ? this.#database.prepare(`DELETE FROM memberships WHERE workspace_id = ? AND principal = ? AND role != 'owner'`).run(workspaceId, targetPrincipal)
        : this.#database.prepare(`UPDATE memberships SET role = ? WHERE workspace_id = ? AND principal = ? AND role != 'owner'`).run(role, workspaceId, targetPrincipal);
      if (result.changes !== 1) throw new PairWorkspaceError("workspace_member_missing", 404);
      this.#database.exec("COMMIT");
      return { principal: targetPrincipal, role, membershipRevision: expectedRevision + 1 };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.#database.close();
  }

  #membership(workspaceId, principal) {
    if (!principal) throw new PairWorkspaceError("authentication_required", 401);
    const membership = this.#database.prepare(`
      SELECT role FROM memberships WHERE workspace_id = ? AND principal = ?
    `).get(workspaceId, principal);
    if (!membership) throw new PairWorkspaceError("workspace_not_found", 404);
    return membership;
  }

  #migrate() {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        owner_principal TEXT NOT NULL, tenant_id TEXT NOT NULL, membership_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
        created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id, principal)
      );
      CREATE TABLE IF NOT EXISTS invites (
        token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        role TEXT NOT NULL, uses INTEGER NOT NULL, max_uses INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, correlation_id TEXT NOT NULL, actor_principal TEXT NOT NULL, kind TEXT NOT NULL,
        payload_json TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(workspace_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS events_timeline ON events(workspace_id, sequence);
      CREATE TABLE IF NOT EXISTS cursors (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal TEXT NOT NULL, event_sequence INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, principal)
      );
      CREATE TABLE IF NOT EXISTS presence (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal TEXT NOT NULL, state TEXT NOT NULL, document_id TEXT NOT NULL,
        line INTEGER NOT NULL, column INTEGER NOT NULL, lease_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, principal)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.#ensureColumn("workspaces", "tenant_id", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("workspaces", "membership_revision", "INTEGER NOT NULL DEFAULT 1");
    this.#ensureColumn("events", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("presence", "lease_id", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("presence", "epoch", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("presence", "expires_at", "INTEGER NOT NULL DEFAULT 0");
    for (const workspace of this.#database.prepare("SELECT id, owner_principal, tenant_id FROM workspaces").all()) {
      if (!workspace.tenant_id) this.#database.prepare("UPDATE workspaces SET tenant_id = ? WHERE id = ?").run(tenantOf(workspace.owner_principal), workspace.id);
    }
  }

  #ensureColumn(table, column, definition) {
    if (!this.#database.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
