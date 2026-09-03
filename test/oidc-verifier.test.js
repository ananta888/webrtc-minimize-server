import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import { AuthenticationError, bearerToken, createOidcVerifier } from "../src/oidc-verifier.js";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const config = {
    authMode: "required",
    oidcIssuer: "https://identity.test/realms/webrtc",
    oidcAudience: "webrtc-room-server",
    oidcAlgorithms: ["RS256"],
    oidcJwksUrl: "https://identity.test/certs",
    oidcJwksCacheMs: 60_000,
  };
  const verifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [jwk] }) });
  async function token(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ preferred_username: "ada", ...overrides.payload })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer || config.oidcIssuer)
      .setAudience(overrides.audience || config.oidcAudience)
      .setSubject(overrides.subject || "user-123")
      .setIssuedAt(now)
      .setExpirationTime(overrides.expiration || now + 300)
      .sign(privateKey);
  }
  return { verifier, token };
}

test("OIDC verifier validates signature, issuer, audience, expiry and subject", async () => {
  const { verifier, token } = await fixture();
  const identity = await verifier.verify(await token());
  assert.deepEqual(identity, {
    subject: "user-123",
    issuer: "https://identity.test/realms/webrtc",
    audience: "webrtc-room-server",
    issuedAt: identity.issuedAt,
    expiresAt: identity.expiresAt,
    displayName: "ada",
    algorithm: "RS256",
  });
  assert.ok(identity.issuedAt > 0);
  assert.ok(identity.expiresAt > identity.issuedAt);
  await assert.rejects(verifier.verify(await token({ audience: "other-service" })), (error) => (
    error instanceof AuthenticationError && error.code === "invalid_access_token"
  ));
  await assert.rejects(verifier.verify(await token({ expiration: 1 })), (error) => error.code === "invalid_access_token");
});

test("bearerToken parses only a strict Bearer header", () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.throws(() => bearerToken("Basic abc"), (error) => error.code === "invalid_authorization_header");
});
