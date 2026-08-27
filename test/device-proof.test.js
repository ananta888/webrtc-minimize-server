import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { DeviceProofError, DeviceProofVerifier, deviceProofMessage } from "../src/device-proof.js";

function proof(device, context, now, nonce = crypto.randomBytes(24).toString("base64url")) {
  const signature = crypto.sign("sha256", Buffer.from(deviceProofMessage({ ...context, timestamp: now, nonce })), {
    key: device.privateKey, dsaEncoding: "ieee-p1363",
  });
  return {
    publicKey: device.publicKey.export({ format: "jwk" }),
    timestamp: now,
    nonce,
    signature: signature.toString("base64url"),
  };
}

test("DeviceProofVerifier binds a fresh P-256 signature to exact join fields", () => {
  const verifier = new DeviceProofVerifier({ maxAgeMs: 60_000 });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const context = { roomId: "pair-alpha", mode: "pair", displayName: "Ada" };
  const input = proof(device, context, 100_000);
  const result = verifier.verify(input, context, 100_000);
  assert.match(result.fingerprint, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => verifier.verify(input, context, 100_000), (error) => (
    error instanceof DeviceProofError && error.code === "device_proof_replayed"
  ));
  assert.throws(() => new DeviceProofVerifier().verify(
    proof(device, context, 100_000), { ...context, roomId: "pair-other" }, 100_000,
  ), (error) => error.code === "invalid_device_signature");
});
test("DeviceProofVerifier rejects stale and malformed proofs", () => {
  const verifier = new DeviceProofVerifier({ maxAgeMs: 1_000 });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const context = { roomId: "room-alpha", mode: "room", displayName: "Ada" };
  assert.throws(() => verifier.verify(proof(device, context, 1_000), context, 3_000), (error) => error.code === "stale_device_proof");
  assert.throws(() => verifier.verify({}, context, 1_000), (error) => error.code === "stale_device_proof");
});
