import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { createAppServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createOidcVerifier } from "../src/oidc-verifier.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { BroadcastGrantAuthority } from "../src/broadcast-grant-authority.js";
import { broadcastGrantDeviceProofMessage } from "../src/broadcast-device-proof.js";
import { deviceFingerprint } from "../src/device-proof.js";

async function fixture(t, anonymous) {
  const origin = "https://synthetic-meet.example.test", issuer = "https://synthetic-identity.example/realm";
  const oidcKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = loadConfig({ PUBLIC_ORIGIN: origin, AUTH_MODE: "required", PAIR_WORKSPACE_ENABLED: "false",
    OIDC_ISSUER: issuer, OIDC_AUDIENCE: "human", OIDC_CLIENT_ID: "synthetic-browser" });
  const verifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(oidcKeys.publicKey)] }) });
  const tokenFor = subject => new SignJWT({ preferred_username: "Synthetic viewer" }).setIssuer(issuer).setSubject(subject)
    .setAudience("human").setIssuedAt().setExpirationTime("2m").setProtectedHeader({ alg: "ES256" }).sign(oidcKeys.privateKey);
  const ownerToken = await tokenFor("owner"), otherToken = await tokenFor("other"), identity = await verifier.verify(ownerToken);
  const grants = new BroadcastGrantAuthority({ issuer: origin + "/broadcast-grants", oidcIssuer: issuer,
    oidcAudience: "human", oidcAlgorithms: ["ES256"],
    signingKeys: [{ kid: "synthetic-grants", ...crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }) }] });
  const issued = [];
  for (const method of ["issue", "issueAnonymousPlayback"]) {
    const original = grants[method].bind(grants);
    grants[method] = async (...args) => { const result = await original(...args); issued.push(result); return result; };
  }
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: grants });
  const app = createAppServer({ config, oidcVerifier: verifier, broadcastRuntime: runtime });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), publicKey = device.publicKey.export({ format: "jwk" });
  const member = app.registry.join("room-synthetic", {}, "Synthetic owner", Date.now(), {
    authenticated: true, principal: `${issuer}|owner`, deviceFingerprint: deviceFingerprint(publicKey),
  }).peer;
  const programIds = ["A", "B"].map(label => {
    const programId = runtime.createProgram(identity, member, { requestVersion: 1, roomId: member.roomId,
      title: `Synthetic ${label}`, visibility: anonymous ? "public" : "private" }).control.programId;
    // Control-plane fixture only: no native process, capture, gateway or media output.
    const packagerId = "pkr_aaaaaaaaaaaaaaaa";
    const prepared = runtime.prepareNativePublisher(identity, member, programId, { requestVersion: 1,
      trigger: "user-action", packagerId, sourceIds: ["src_aaaaaaaaaaaaaaaa"], requestedRenditions: 2,
      allowHardwareAcceleration: false }, request => request);
    runtime.markNativeOutputReady(prepared.admission.resourceRef, packagerId, prepared.lease.fencingRevision);
    return programId;
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.registry.leave(member);
    for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
      for (const socket of server.clients) socket.terminate();
    }
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  const token = anonymous ? null : ownerToken;
  const request = async (programId, suffix, body, bearer = token) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/broadcasts/${programId}/${suffix}`, {
      method: "POST", headers: { origin, "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const challenge = await request(programIds[0], "playback-challenges", { requestVersion: 1 });
  assert.equal(challenge.status, 201);
  const timestamp = Date.now(), nonce = crypto.randomBytes(24).toString("base64url");
  const signature = crypto.sign("sha256", Buffer.from(broadcastGrantDeviceProofMessage(challenge.body.proofContext, timestamp, nonce)),
    { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const input = { requestVersion: 1, challengeId: challenge.body.challengeId, deviceProof: { publicKey, timestamp, nonce, signature } };
  return { runtime, grants, issued, request, input, programIds, otherToken };
}

for (const anonymous of [false, true]) for (const mismatch of ["existing-program", "unknown-program", "identity"]) {
  test(`${anonymous ? "anonymous" : "OIDC"} HTTP playback rejects ${mismatch} before grant issuance and challenge consumption`, async t => {
    const f = await fixture(t, anonymous), [programA, programB] = f.programIds;
    const wrongProgram = mismatch === "existing-program" ? programB : mismatch === "unknown-program" ? "prg_zzzzzzzzzzzzzzzz" : programA;
    const rejected = await f.request(wrongProgram, "playback", f.input, mismatch === "identity" ? f.otherToken : undefined);
    assert.equal(rejected.status, 404);
    assert.equal(f.issued.length, 0, "a rejected scope must not issue a JWT or reserve grant capacity");
    assert.equal(f.runtime.challengeCount, 1, "a rejected scope must leave the legitimate challenge usable");
    const accepted = await f.request(programA, "playback", f.input);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.program.programId, programA);
    assert.equal(f.issued.length, 1);
    assert.equal(accepted.body.playbackGrant, f.issued[0].token);
    assert.equal(f.issued[0].grant.programId, programA);
    assert.equal(f.issued[0].grant.resourceRef, accepted.body.resourceRef);
    assert.equal(f.runtime.challengeCount, 0);
    assert.equal((await f.request(programA, "playback", f.input)).status, 404);
    assert.equal(f.issued.length, 1);
  });
}

for (const anonymous of [false, true]) test(`${anonymous ? "anonymous" : "OIDC"} correctly scoped invalid playback proof remains a single attempt`, async t => {
  const f = await fixture(t, anonymous), [programId] = f.programIds;
  const invalid = { ...f.input, deviceProof: { ...f.input.deviceProof, signature: "A".repeat(86) } };
  const response = await f.request(programId, "playback", invalid);
  assert.ok(response.status >= 400 && response.status < 500);
  assert.equal(f.issued.length, 0);
  assert.equal(f.runtime.challengeCount, 0);
  assert.equal((await f.request(programId, "playback", f.input)).status, 404);
});

test("runtime playback requires an explicit valid program and does not consume another identity's challenge", async t => {
  const f = await fixture(t, false), [programId] = f.programIds;
  for (const invalid of [undefined, null, {}, "", "prg_short", `${programId}/other`]) {
    await assert.rejects(f.runtime.authorizePlayback(null, invalid, f.input), error => error.code === "broadcast_not_available");
    assert.equal(f.runtime.challengeCount, 1);
    assert.equal(f.issued.length, 0);
  }
  assert.equal((await f.request(programId, "playback", f.input, null)).status, 401);
  assert.equal(f.runtime.challengeCount, 1);
  assert.equal(f.issued.length, 0);
  assert.equal((await f.request(programId, "playback", f.input)).status, 201);
  assert.equal(f.runtime.challengeCount, 0);
  assert.equal(f.issued.length, 1);
});
