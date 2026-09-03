import crypto from "node:crypto";

import { broadcastDeviceRef } from "./broadcast-identifiers.js";

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PRINCIPAL_REF_PATTERN = /^(sub|pkr)_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE_REF_PATTERN = /^res_[A-Za-z0-9_-]{16,64}$/;
const CONTEXT_FIELDS = new Set([
  "tenantId",
  "subjectRef",
  "roomId",
  "programId",
  "programRevision",
  "programEpoch",
  "grantKind",
  "tokenAudience",
  "audienceRef",
  "resourceRef",
  "pathHash",
  "actions",
]);

export class BroadcastDeviceProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastDeviceProofError";
    this.code = code;
  }
}

function fail(code) {
  throw new BroadcastDeviceProofError(code);
}

function validatePublicJwk(value) {
  const allowed = new Set(["kty", "crv", "x", "y", "ext", "key_ops"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !allowed.has(field))
    || Object.hasOwn(value, "d")
    || value.kty !== "EC" || value.crv !== "P-256"
    || !BASE64URL_32.test(value.x || "") || !BASE64URL_32.test(value.y || "")
    || (value.ext !== undefined && value.ext !== true)
    || (value.key_ops !== undefined && (
      !Array.isArray(value.key_ops) || value.key_ops.some((operation) => operation !== "verify")
    ))) fail("invalid_broadcast_device_public_key");
  return Object.freeze({ kty: "EC", crv: "P-256", x: value.x, y: value.y });
}

function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !CONTEXT_FIELDS.has(field))
    || Object.keys(value).length !== CONTEXT_FIELDS.size
    || !Number.isSafeInteger(value.programRevision) || value.programRevision < 1
    || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 1
    || !PRINCIPAL_REF_PATTERN.test(value.audienceRef || "")
    || !RESOURCE_REF_PATTERN.test(value.resourceRef || "")
    || !SHA256_PATTERN.test(value.pathHash || "")
    || !Array.isArray(value.actions) || value.actions.length < 1
    || value.actions.some((action) => typeof action !== "string")) {
    fail("invalid_broadcast_device_context");
  }
  return Object.freeze({ ...value, actions: Object.freeze([...value.actions].sort()) });
}

export function broadcastGrantDeviceProofMessage(context, timestamp, nonce) {
  const normalized = normalizeContext(context);
  return [
    "webrtc-broadcast-grant-v1",
    normalized.tenantId,
    normalized.subjectRef,
    normalized.roomId,
    normalized.programId,
    normalized.programRevision,
    normalized.programEpoch,
    normalized.grantKind,
    normalized.tokenAudience,
    normalized.audienceRef,
    normalized.resourceRef,
    normalized.pathHash,
    normalized.actions.join(","),
    timestamp,
    nonce,
  ].join("\n");
}

export class BroadcastDeviceProofVerifier {
  #maxAgeMs;
  #seen = new Map();

  constructor({ maxAgeMs = 60_000 } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 5_000 || maxAgeMs > 5 * 60_000) {
      throw new RangeError("invalid_broadcast_device_proof_max_age");
    }
    this.#maxAgeMs = maxAgeMs;
  }

  verify(value, context, now = Date.now()) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !new Set([
        "publicKey", "timestamp", "nonce", "signature",
      ]).has(field))) fail("broadcast_device_proof_required");
    const timestamp = Number(value.timestamp);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > this.#maxAgeMs) {
      fail("stale_broadcast_device_proof");
    }
    if (!NONCE_PATTERN.test(value.nonce || "")) fail("invalid_broadcast_device_nonce");
    const publicKey = validatePublicJwk(value.publicKey);
    const fingerprint = crypto.createHash("sha256")
      .update(`P-256\n${publicKey.x}\n${publicKey.y}`)
      .digest("base64url");
    const replayKey = `${fingerprint}:${value.nonce}`;
    this.prune(now);
    if (this.#seen.has(replayKey)) fail("broadcast_device_proof_replayed");

    let signature;
    try {
      signature = Buffer.from(String(value.signature || ""), "base64url");
    } catch {
      fail("invalid_broadcast_device_signature");
    }
    if (signature.length !== 64) fail("invalid_broadcast_device_signature");
    let verified = false;
    try {
      const key = crypto.createPublicKey({ key: publicKey, format: "jwk" });
      verified = crypto.verify(
        "sha256",
        Buffer.from(broadcastGrantDeviceProofMessage(context, timestamp, value.nonce)),
        { key, dsaEncoding: "ieee-p1363" },
        signature,
      );
    } catch (error) {
      if (error instanceof BroadcastDeviceProofError) throw error;
      fail("invalid_broadcast_device_public_key");
    }
    if (!verified) fail("invalid_broadcast_device_signature");
    this.#seen.set(replayKey, now + this.#maxAgeMs);
    return Object.freeze({ fingerprint, deviceRef: broadcastDeviceRef(fingerprint), publicKey });
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt < now) this.#seen.delete(key);
    }
  }
}
