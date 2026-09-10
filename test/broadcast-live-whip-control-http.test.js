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

test("real OIDC HTTP live WHIP update/delete remain single-use and cannot become create or survive stop", async t => {
  const origin = "https://synthetic-meet.example.test", issuer = "https://synthetic-identity.example/realm";
  const oidcKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = loadConfig({ PUBLIC_ORIGIN: origin, AUTH_MODE: "required", PAIR_WORKSPACE_ENABLED: "false",
    OIDC_ISSUER: issuer, OIDC_AUDIENCE: "human", OIDC_CLIENT_ID: "synthetic-browser" });
  const verifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(oidcKeys.publicKey)] }) });
  const token = await new SignJWT({ preferred_username: "Synthetic owner" }).setIssuer(issuer).setSubject("owner")
    .setAudience("human").setIssuedAt().setExpirationTime("2m").setProtectedHeader({ alg: "ES256" }).sign(oidcKeys.privateKey);
  const identity = await verifier.verify(token);
  const grants = new BroadcastGrantAuthority({ issuer: origin + "/broadcast-grants", oidcIssuer: issuer,
    oidcAudience: "human", oidcAlgorithms: ["ES256"],
    signingKeys: [{ kid: "synthetic-grants", ...crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }) }] });
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: grants });
  const app = createAppServer({ config, oidcVerifier: verifier, broadcastRuntime: runtime });
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), publicKey = device.publicKey.export({ format: "jwk" });
  const member = app.registry.join("room-synthetic", {}, "Synthetic owner", Date.now(), {
    authenticated: true, principal: `${issuer}|owner`, deviceFingerprint: deviceFingerprint(publicKey),
  }).peer;
  const programId = runtime.createProgram(identity, member, { requestVersion: 1, roomId: member.roomId,
    title: "Synthetic live program", visibility: "private" }).control.programId;
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.registry.leave(member);
    for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
      for (const socket of server.clients) socket.terminate();
    }
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api/broadcasts/${programId}`;
  const request = async (suffix, body, method = "POST") => {
    const response = await fetch(base + suffix, { method,
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const challengeFor = action => request("/publisher-challenges", { requestVersion: 1, action,
    sourceIds: ["src_aaaaaaaaaaaaaaaa"], deviceFingerprint: member.deviceFingerprint });
  const authorize = async action => {
    const challenge = await challengeFor(action); assert.equal(challenge.status, 201);
    const timestamp = Date.now(), nonce = crypto.randomBytes(24).toString("base64url");
    const signature = crypto.sign("sha256", Buffer.from(broadcastGrantDeviceProofMessage(challenge.body.proofContext, timestamp, nonce)),
      { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const input = { requestVersion: 1, challengeId: challenge.body.challengeId, deviceProof: { publicKey, timestamp, nonce, signature } };
    const accepted = await request("/publisher-authorizations", input);
    assert.equal(accepted.status, 201, `${action} must be authorized in the current program state`);
    assert.equal((await request("/publisher-authorizations", input)).status, 404, "challenge remains single-use");
    return accepted.body;
  };
  const initial = await authorize("whip:create");
  runtime.markPublished(initial.resourceRef);
  assert.equal(runtime.listMine(identity).owned[0].availability, "live");
  for (const action of ["whip:update", "whip:delete"]) {
    const issued = await authorize(action), path = `/broadcast/ingest/${issued.resourceRef}/session`;
    assert.equal(issued.program.programEpoch, initial.program.programEpoch);
    assert.equal(issued.resourceRef, initial.resourceRef);
    assert.equal(issued.resourceUrl, undefined, "maintenance cannot create a new ingest URL");
    await assert.rejects(grants.authorizeGatewayBearer(`Bearer ${issued.accessToken}`, { action: "whip:create", grantKinds: ["publisher"], path }));
    await assert.rejects(grants.authorizeGatewayBearer(`Bearer ${issued.accessToken}`, { action, grantKinds: ["publisher"],
      path: "/broadcast/ingest/res_bbbbbbbbbbbbbbbb/session" }));
    const consumed = await grants.authorizeGatewayBearer(`Bearer ${issued.accessToken}`, { action, grantKinds: ["publisher"], path });
    assert.equal(consumed.status, "consumed"); assert.deepEqual(consumed.actions, [action]);
    await assert.rejects(grants.authorizeGatewayBearer(`Bearer ${issued.accessToken}`, { action, grantKinds: ["publisher"], path }),
      error => error.code === "inactive_broadcast_grant");
    assert.equal(runtime.listMine(identity).owned[0].availability, "live", "issuing/consuming control authority is not a media-stop ACK");
  }
  assert.equal((await challengeFor("whip:create")).status, 409);
  const held = await authorize("whip:delete");
  app.registry.leave(member);
  assert.equal((await challengeFor("whip:update")).status, 403, "no new authority without room membership");
  assert.equal((await request("", null, "DELETE")).status, 200);
  assert.equal(runtime.listMine(identity).owned[0].availability, "ended");
  await assert.rejects(grants.authorizeGatewayBearer(`Bearer ${held.accessToken}`, { action: "whip:delete",
    grantKinds: ["publisher"], path: `/broadcast/ingest/${held.resourceRef}/session` }),
    error => error.code === "revoked_broadcast_program_epoch" || error.code === "inactive_broadcast_grant");
});
