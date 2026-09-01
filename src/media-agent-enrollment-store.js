import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENROLLMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JWK_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PLATFORMS = new Set(["linux", "macos", "windows"]);

export class MediaAgentEnrollmentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MediaAgentEnrollmentError";
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function normalizePrincipal(value) {
  const principal = String(value || "");
  const separator = principal.lastIndexOf("|");
  if (separator < 1 || separator === principal.length - 1 || principal.length > 1024
    || /[\u0000-\u001f\u007f]/.test(principal)) {
    throw new MediaAgentEnrollmentError("invalid_agent_owner", 403);
  }
  return principal;
}

function normalizeLabel(value) {
  const label = String(value || "Mein Media-Agent").trim().replace(/\s+/g, " ");
  if (label.length < 1 || label.length > 48 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new MediaAgentEnrollmentError("invalid_agent_label");
  }
  return label;
}

function normalizePlatform(value) {
  const platform = String(value || "").toLowerCase();
  if (!PLATFORMS.has(platform)) throw new MediaAgentEnrollmentError("invalid_agent_platform");
  return platform;
}

export function normalizeAgentPublicKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 5
    || !["kty", "crv", "x", "y", "ext"].every((field) => Object.hasOwn(value, field))
    || value.kty !== "EC" || value.crv !== "P-256" || value.ext !== true
    || !JWK_COORDINATE_PATTERN.test(value.x || "") || !JWK_COORDINATE_PATTERN.test(value.y || "")) {
    throw new MediaAgentEnrollmentError("invalid_agent_public_key");
  }
  try {
    crypto.createPublicKey({ key: value, format: "jwk" });
  } catch {
    throw new MediaAgentEnrollmentError("invalid_agent_public_key");
  }
  return Object.freeze({ kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true });
}

function publicKeyFingerprint(publicKey) {
  return digest(`P-256\0${publicKey.x}\0${publicKey.y}`);
}

function registrationRow(row) {
  return Object.freeze({
    id: row.agentId,
    label: row.label,
    platform: row.platform,
    keyFingerprint: row.keyFingerprint,
    createdAt: row.createdAt,
    lastAuthenticatedAt: row.lastAuthenticatedAt || 0,
    revokedAt: row.revokedAt || 0,
  });
}

export class MediaAgentEnrollmentStore {
  #database;
  #ttlMs;
  #maxAgentsPerPrincipal;
  #maxEnrollmentsPerHour;

  constructor({
    filename = ":memory:",
    ttlMs = 10 * 60 * 1000,
    maxAgentsPerPrincipal = 3,
    maxEnrollmentsPerHour = 5,
  } = {}) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#ttlMs = ttlMs;
    this.#maxAgentsPerPrincipal = maxAgentsPerPrincipal;
    this.#maxEnrollmentsPerHour = maxEnrollmentsPerHour;
    this.#migrate();
  }

  createEnrollment({ principal, label, platform, now = Date.now() }) {
    const ownerPrincipal = normalizePrincipal(principal);
    const normalizedLabel = normalizeLabel(label);
    const normalizedPlatform = normalizePlatform(platform);
    this.prune(now);
    const activeAgents = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM media_agent_registrations
      WHERE owner_principal = ? AND revoked_at IS NULL
    `).get(ownerPrincipal).count);
    const pendingAgents = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM media_agent_enrollments
      WHERE owner_principal = ? AND consumed_at IS NULL AND expires_at >= ?
    `).get(ownerPrincipal, now).count);
    if (activeAgents + pendingAgents >= this.#maxAgentsPerPrincipal) {
      throw new MediaAgentEnrollmentError("media_agent_quota_reached", 409);
    }
    const recent = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM media_agent_enrollments
      WHERE owner_principal = ? AND created_at >= ?
    `).get(ownerPrincipal, now - 60 * 60 * 1000).count);
    if (recent >= this.#maxEnrollmentsPerHour) {
      throw new MediaAgentEnrollmentError("media_agent_enrollment_rate_limited", 429);
    }
    let agentId;
    do {
      agentId = `edge-${crypto.randomBytes(8).toString("hex")}`;
    } while (this.hasAgentId(agentId));
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + this.#ttlMs;
    this.#database.prepare(`
      INSERT INTO media_agent_enrollments
        (token_hash, agent_id, owner_principal, label, platform, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(digest(token), agentId, ownerPrincipal, normalizedLabel, normalizedPlatform, now, expiresAt);
    return Object.freeze({
      agentId,
      label: normalizedLabel,
      platform: normalizedPlatform,
      token,
      expiresAt,
    });
  }

  pendingEnrollment(token, agentId, now = Date.now()) {
    if (!ENROLLMENT_TOKEN_PATTERN.test(token || "") || !AGENT_ID_PATTERN.test(agentId || "")) {
      throw new MediaAgentEnrollmentError("invalid_agent_enrollment", 403);
    }
    const row = this.#database.prepare(`
      SELECT agent_id AS agentId, owner_principal AS ownerPrincipal, label, platform,
        created_at AS createdAt, expires_at AS expiresAt
      FROM media_agent_enrollments
      WHERE token_hash = ? AND agent_id = ? AND consumed_at IS NULL AND expires_at >= ?
    `).get(digest(token), agentId, now);
    if (!row) throw new MediaAgentEnrollmentError("invalid_agent_enrollment", 403);
    return Object.freeze(row);
  }

  completeEnrollment({ token, agentId, publicKey, now = Date.now() }) {
    const normalizedKey = normalizeAgentPublicKey(publicKey);
    const pending = this.pendingEnrollment(token, agentId, now);
    const keyFingerprint = publicKeyFingerprint(normalizedKey);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database.prepare(`
        SELECT consumed_at AS consumedAt, expires_at AS expiresAt
        FROM media_agent_enrollments WHERE token_hash = ? AND agent_id = ?
      `).get(digest(token), agentId);
      if (!current || current.consumedAt || current.expiresAt < now) {
        throw new MediaAgentEnrollmentError("invalid_agent_enrollment", 403);
      }
      const activeAgents = Number(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM media_agent_registrations
        WHERE owner_principal = ? AND revoked_at IS NULL
      `).get(pending.ownerPrincipal).count);
      if (activeAgents >= this.#maxAgentsPerPrincipal) {
        throw new MediaAgentEnrollmentError("media_agent_quota_reached", 409);
      }
      this.#database.prepare(`
        INSERT INTO media_agent_registrations
          (agent_id, owner_principal, label, platform, public_key_json, key_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        agentId,
        pending.ownerPrincipal,
        pending.label,
        pending.platform,
        JSON.stringify(normalizedKey),
        keyFingerprint,
        now,
      );
      this.#database.prepare(`
        UPDATE media_agent_enrollments SET consumed_at = ? WHERE token_hash = ?
      `).run(now, digest(token));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (error instanceof MediaAgentEnrollmentError) throw error;
      throw new MediaAgentEnrollmentError("media_agent_registration_conflict", 409);
    }
    return Object.freeze({
      id: agentId,
      ownerPrincipal: pending.ownerPrincipal,
      authType: "public-key",
      publicKey: normalizedKey,
      label: pending.label,
      keyFingerprint,
    });
  }

  definitions() {
    return this.#database.prepare(`
      SELECT agent_id AS agentId, owner_principal AS ownerPrincipal, label,
        public_key_json AS publicKeyJson, key_fingerprint AS keyFingerprint
      FROM media_agent_registrations WHERE revoked_at IS NULL ORDER BY created_at
    `).all().map((row) => Object.freeze({
      id: row.agentId,
      ownerPrincipal: row.ownerPrincipal,
      authType: "public-key",
      publicKey: Object.freeze(JSON.parse(row.publicKeyJson)),
      label: row.label,
      keyFingerprint: row.keyFingerprint,
    }));
  }

  list(principal) {
    const ownerPrincipal = normalizePrincipal(principal);
    return this.#database.prepare(`
      SELECT agent_id AS agentId, label, platform, key_fingerprint AS keyFingerprint,
        created_at AS createdAt, last_authenticated_at AS lastAuthenticatedAt, revoked_at AS revokedAt
      FROM media_agent_registrations WHERE owner_principal = ?
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 20
    `).all(ownerPrincipal).map(registrationRow);
  }

  markAuthenticated(agentId, now = Date.now()) {
    this.#database.prepare(`
      UPDATE media_agent_registrations SET last_authenticated_at = ?
      WHERE agent_id = ? AND revoked_at IS NULL
    `).run(now, agentId);
  }

  revoke(principal, agentId, now = Date.now()) {
    const ownerPrincipal = normalizePrincipal(principal);
    if (!AGENT_ID_PATTERN.test(agentId || "")) {
      throw new MediaAgentEnrollmentError("media_agent_not_found", 404);
    }
    const result = this.#database.prepare(`
      UPDATE media_agent_registrations SET revoked_at = ?
      WHERE agent_id = ? AND owner_principal = ? AND revoked_at IS NULL
    `).run(now, agentId, ownerPrincipal);
    if (Number(result.changes) !== 1) throw new MediaAgentEnrollmentError("media_agent_not_found", 404);
    return Object.freeze({ agentId, revokedAt: now });
  }

  hasAgentId(agentId) {
    if (!AGENT_ID_PATTERN.test(agentId || "")) return true;
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM media_agent_registrations WHERE agent_id = ?
      UNION SELECT 1 FROM media_agent_enrollments WHERE agent_id = ? LIMIT 1
    `).get(agentId, agentId));
  }

  prune(now = Date.now()) {
    this.#database.prepare(`
      DELETE FROM media_agent_enrollments
      WHERE expires_at < ? AND created_at < ?
    `).run(now, now - 60 * 60 * 1000);
  }

  close() {
    this.#database.close();
  }

  #migrate() {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS media_agent_enrollments (
        token_hash TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        owner_principal TEXT NOT NULL,
        label TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('linux','macos','windows')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS media_agent_enrollments_owner
        ON media_agent_enrollments(owner_principal, created_at);
      CREATE TABLE IF NOT EXISTS media_agent_registrations (
        agent_id TEXT PRIMARY KEY,
        owner_principal TEXT NOT NULL,
        label TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('linux','macos','windows')),
        public_key_json TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_authenticated_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS media_agent_registrations_owner
        ON media_agent_registrations(owner_principal, revoked_at, created_at);
    `);
  }
}
