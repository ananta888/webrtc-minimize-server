import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PACKAGER_ID = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;
const PLATFORMS = new Set(["linux", "macos", "windows"]);

export class NativePackagerEnrollmentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NativePackagerEnrollmentError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new NativePackagerEnrollmentError(code, status); }
function digest(value) { return crypto.createHash("sha256").update(value).digest("base64url"); }

function principal(value) {
  const result = String(value || "");
  const separator = result.lastIndexOf("|");
  if (separator < 1 || separator === result.length - 1 || result.length > 1024
    || /[\u0000-\u001f\u007f]/.test(result)) fail("invalid_native_packager_owner", 403);
  return result;
}

function label(value) {
  const result = String(value || "Mein Broadcast-Packager").trim().replace(/\s+/g, " ");
  if (result.length < 1 || result.length > 48 || /[\u0000-\u001f\u007f]/.test(result)) {
    fail("invalid_native_packager_label");
  }
  return result;
}

function platform(value) {
  const result = String(value || "").toLowerCase();
  if (!PLATFORMS.has(result)) fail("invalid_native_packager_platform");
  return result;
}

export function normalizeNativePackagerPublicKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 5
    || !["kty", "crv", "x", "y", "ext"].every((field) => Object.hasOwn(value, field))
    || value.kty !== "EC" || value.crv !== "P-256" || value.ext !== true
    || !COORDINATE.test(value.x || "") || !COORDINATE.test(value.y || "")) {
    fail("invalid_native_packager_public_key");
  }
  try { crypto.createPublicKey({ key: value, format: "jwk" }); } catch {
    fail("invalid_native_packager_public_key");
  }
  return Object.freeze({ kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true });
}

function row(value) {
  return Object.freeze({
    id: value.packagerId,
    label: value.label,
    platform: value.platform,
    keyFingerprint: value.keyFingerprint,
    createdAt: value.createdAt,
    lastAuthenticatedAt: value.lastAuthenticatedAt || 0,
    revokedAt: value.revokedAt || 0,
  });
}

export class NativePackagerEnrollmentStore {
  #database;
  #ttlMs;
  #maximum;

  constructor({ filename = ":memory:", ttlMs = 10 * 60_000, maximumPerPrincipal = 3 } = {}) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#ttlMs = ttlMs;
    this.#maximum = maximumPerPrincipal;
    this.#migrate();
  }

  createEnrollment({ ownerPrincipal, label: requestedLabel, platform: requestedPlatform, now = Date.now() }) {
    const owner = principal(ownerPrincipal);
    const displayLabel = label(requestedLabel);
    const os = platform(requestedPlatform);
    this.prune(now);
    const registered = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM native_packager_registrations
      WHERE owner_principal = ? AND revoked_at IS NULL
    `).get(owner).count);
    const pending = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM native_packager_enrollments
      WHERE owner_principal = ? AND consumed_at IS NULL AND expires_at >= ?
    `).get(owner, now).count);
    if (registered + pending >= this.#maximum) fail("native_packager_quota_reached", 409);
    const packagerId = `pkr_${crypto.randomBytes(18).toString("base64url")}`;
    const enrollmentToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + this.#ttlMs;
    this.#database.prepare(`
      INSERT INTO native_packager_enrollments
        (token_hash, packager_id, owner_principal, label, platform, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(digest(enrollmentToken), packagerId, owner, displayLabel, os, now, expiresAt);
    return Object.freeze({ packagerId, label: displayLabel, platform: os, enrollmentToken, expiresAt });
  }

  pending(enrollmentToken, packagerId, now = Date.now()) {
    if (!TOKEN.test(enrollmentToken || "") || !PACKAGER_ID.test(packagerId || "")) {
      fail("invalid_native_packager_enrollment", 403);
    }
    const result = this.#database.prepare(`
      SELECT packager_id AS packagerId, owner_principal AS ownerPrincipal, label, platform,
        expires_at AS expiresAt
      FROM native_packager_enrollments
      WHERE token_hash = ? AND packager_id = ? AND consumed_at IS NULL AND expires_at >= ?
    `).get(digest(enrollmentToken), packagerId, now);
    if (!result) fail("invalid_native_packager_enrollment", 403);
    return Object.freeze(result);
  }

  complete({ enrollmentToken, packagerId, publicKey, now = Date.now() }) {
    const key = normalizeNativePackagerPublicKey(publicKey);
    const enrollment = this.pending(enrollmentToken, packagerId, now);
    const keyFingerprint = digest(`P-256\0${key.x}\0${key.y}`);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.#database.prepare(`
        UPDATE native_packager_enrollments SET consumed_at = ?
        WHERE token_hash = ? AND packager_id = ? AND consumed_at IS NULL AND expires_at >= ?
      `).run(now, digest(enrollmentToken), packagerId, now);
      if (Number(consumed.changes) !== 1) fail("invalid_native_packager_enrollment", 403);
      this.#database.prepare(`
        INSERT INTO native_packager_registrations
          (packager_id, owner_principal, label, platform, public_key_json, key_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(packagerId, enrollment.ownerPrincipal, enrollment.label, enrollment.platform,
        JSON.stringify(key), keyFingerprint, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (error instanceof NativePackagerEnrollmentError) throw error;
      fail("native_packager_registration_conflict", 409);
    }
    return Object.freeze({
      id: packagerId,
      ownerPrincipal: enrollment.ownerPrincipal,
      label: enrollment.label,
      platform: enrollment.platform,
      publicKey: key,
      keyFingerprint,
    });
  }

  definitions() {
    return this.#database.prepare(`
      SELECT packager_id AS packagerId, owner_principal AS ownerPrincipal, label, platform,
        public_key_json AS publicKeyJson, key_fingerprint AS keyFingerprint
      FROM native_packager_registrations WHERE revoked_at IS NULL ORDER BY created_at
    `).all().map((value) => Object.freeze({
      id: value.packagerId,
      ownerPrincipal: value.ownerPrincipal,
      label: value.label,
      platform: value.platform,
      publicKey: Object.freeze(JSON.parse(value.publicKeyJson)),
      keyFingerprint: value.keyFingerprint,
    }));
  }

  list(ownerPrincipal) {
    const owner = principal(ownerPrincipal);
    return this.#database.prepare(`
      SELECT packager_id AS packagerId, label, platform, key_fingerprint AS keyFingerprint,
        created_at AS createdAt, last_authenticated_at AS lastAuthenticatedAt, revoked_at AS revokedAt
      FROM native_packager_registrations WHERE owner_principal = ? ORDER BY created_at DESC LIMIT 20
    `).all(owner).map(row);
  }

  markAuthenticated(packagerId, now = Date.now()) {
    this.#database.prepare(`
      UPDATE native_packager_registrations SET last_authenticated_at = ?
      WHERE packager_id = ? AND revoked_at IS NULL
    `).run(now, packagerId);
  }

  revoke(ownerPrincipal, packagerId, now = Date.now()) {
    const owner = principal(ownerPrincipal);
    if (!PACKAGER_ID.test(packagerId || "")) fail("native_packager_not_found", 404);
    const result = this.#database.prepare(`
      UPDATE native_packager_registrations SET revoked_at = ?
      WHERE packager_id = ? AND owner_principal = ? AND revoked_at IS NULL
    `).run(now, packagerId, owner);
    if (Number(result.changes) !== 1) fail("native_packager_not_found", 404);
    return Object.freeze({ packagerId, revokedAt: now });
  }

  prune(now = Date.now()) {
    this.#database.prepare(`DELETE FROM native_packager_enrollments WHERE expires_at < ?`).run(now);
  }

  close() { this.#database.close(); }

  #migrate() {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS native_packager_enrollments (
        token_hash TEXT PRIMARY KEY,
        packager_id TEXT NOT NULL UNIQUE,
        owner_principal TEXT NOT NULL,
        label TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('linux','macos','windows')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS native_packager_enrollments_owner
        ON native_packager_enrollments(owner_principal, expires_at);
      CREATE TABLE IF NOT EXISTS native_packager_registrations (
        packager_id TEXT PRIMARY KEY,
        owner_principal TEXT NOT NULL,
        label TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('linux','macos','windows')),
        public_key_json TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_authenticated_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS native_packager_registrations_owner
        ON native_packager_registrations(owner_principal, revoked_at, created_at);
    `);
  }
}
