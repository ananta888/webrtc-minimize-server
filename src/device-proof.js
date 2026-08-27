import crypto from "node:crypto";

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export class DeviceProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "DeviceProofError";
    this.code = code;
  }
}
export function deviceProofMessage({ roomId, mode, displayName, timestamp, nonce }) {
  return `webrtc-join-v1\n${roomId}\n${mode}\n${displayName}\n${timestamp}\n${nonce}`;
}

function validatePublicJwk(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || value.kty !== "EC" || value.crv !== "P-256"
    || !BASE64URL_32.test(value.x || "") || !BASE64URL_32.test(value.y || "")
  ) throw new DeviceProofError("invalid_device_public_key");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

export function deviceFingerprint(publicJwk) {
  const key = validatePublicJwk(publicJwk);
  return crypto.createHash("sha256")
    .update(`P-256\n${key.x}\n${key.y}`)
    .digest("base64url");
}

export class DeviceProofVerifier {
  #maxAgeMs;
  #seen = new Map();

  constructor({ maxAgeMs = 60_000 } = {}) {
    this.#maxAgeMs = maxAgeMs;
  }

  verify(proof, context, now = Date.now()) {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      throw new DeviceProofError("device_proof_required");
    }
    const timestamp = Number(proof.timestamp);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > this.#maxAgeMs) {
      throw new DeviceProofError("stale_device_proof");
    }
    if (!NONCE_PATTERN.test(proof.nonce || "")) throw new DeviceProofError("invalid_device_nonce");
    const publicKey = validatePublicJwk(proof.publicKey);
    const fingerprint = deviceFingerprint(publicKey);
    const replayKey = `${fingerprint}:${proof.nonce}`;
    this.prune(now);
    if (this.#seen.has(replayKey)) throw new DeviceProofError("device_proof_replayed");
    let signature;
    try {
      signature = Buffer.from(String(proof.signature || ""), "base64url");
    } catch {
      throw new DeviceProofError("invalid_device_signature");
    }
    if (signature.length !== 64) throw new DeviceProofError("invalid_device_signature");
    const message = deviceProofMessage({ ...context, timestamp, nonce: proof.nonce });
    let verified = false;
    try {
      const key = crypto.createPublicKey({ key: publicKey, format: "jwk" });
      verified = crypto.verify("sha256", Buffer.from(message), {
        key,
        dsaEncoding: "ieee-p1363",
      }, signature);
    } catch {
      throw new DeviceProofError("invalid_device_public_key");
    }
    if (!verified) throw new DeviceProofError("invalid_device_signature");
    this.#seen.set(replayKey, now + this.#maxAgeMs);
    return Object.freeze({ fingerprint, publicKey });
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.#seen) if (expiresAt < now) this.#seen.delete(key);
  }
}
