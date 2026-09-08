// Ephemeral test-only keys; never operator trust or production evidence.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { SignJWT } from "jose";
import { deviceProofMessage } from "../../src/device-proof.js";

export const issuer = "https://synthetic-hub.example.test";
export const join = Object.freeze({ roomId: "room-0123456789abcdef01", mode: "room", displayName: "Ananta (KI)" });
export function trustFixture(now = Math.floor(Date.now() / 1000)) {
  const keys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const profile = { schema: "ananta.meet-machine-trust.v1", revision: 1, issuer,
    audiences: ["ananta-meet-machine-v1", "ananta-meet-machine-v2"],
    keys: keys.map((key, i) => ({ kid: `synthetic-${i}`, x: key.publicKey.export({ format: "jwk" }).x,
      notBefore: now - 120, notAfter: now + 1200 })),
    scopes: [{ subject: "ananta", tenantId: "tenant", projectId: "project",
      capabilities: ["avatar.publish", "chat.read", "chat.send", "screen.publish", "speech.publish"] }] };
  const payload = (changes = {}) => ({ iss: issuer, aud: "ananta-meet-machine-v2", sub: "ananta",
    iat: now, exp: now + 120, jti: randomBytes(16).toString("hex"), roomId: join.roomId,
    taskId: "task", tenantId: "tenant", projectId: "project", runtimeId: "runtime", sessionId: "hub-session",
    capabilities: ["chat.read", "chat.send"], ...changes });
  const token = (changes = {}, keyIndex = 0, header = {}) => new SignJWT(payload(changes))
    .setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt", kid: `synthetic-${keyIndex}`, ...header })
    .sign(keys[keyIndex].privateKey);
  return { now, keys, profile, payload, token };
}

export function testDevice() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return context => {
    const timestamp = Date.now(), nonce = randomBytes(24).toString("base64url");
    return { publicKey: pair.publicKey.export({ format: "jwk" }), timestamp, nonce,
      signature: sign("sha256", Buffer.from(deviceProofMessage({ ...context, timestamp, nonce })),
        { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
}
