import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import test from "node:test";
import { createLocalJWKSet, SignJWT } from "jose";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.js";
import { createOidcVerifier } from "../src/oidc-verifier.js";
import { trustFixture, testDevice, join, issuer } from "./helpers/machine-trust.mjs";

test("atomic public-profile reload selectively removes real machine memberships, preserves human OIDC and renews the survivor", { timeout: 8000 }, async t => {
  const f = trustFixture(), directory = mkdtempSync(pathJoin(tmpdir(), "machine-live-trust-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = pathJoin(directory, "machine-trust.json");
  writeFileSync(file, JSON.stringify(f.profile));
  const config = { host: "127.0.0.1", port: 0, authMode: "required", machineHubTrustProfile: f.profile,
    machineHubTrustReloadFile: file, oidcIssuer: issuer, oidcAudience: "human", oidcAlgorithms: ["EdDSA"],
    oidcJwksUrl: issuer + "/jwks", stunUrls: [], turnServers: [], mediaE2eeMode: "required" };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [f.keys[0].publicKey.export({ format: "jwk" })] }) });
  const app = createAppServer({ config, oidcVerifier });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of app.webSocketServer.clients) socket.terminate(); app.server.closeAllConnections(); app.server.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, token, body) => fetch(base + path, { method: "POST", signal: AbortSignal.timeout(2000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const humanToken = await new SignJWT({ preferred_username: "Synthetic Human" }).setIssuer(issuer).setAudience("human")
    .setSubject("synthetic-human").setIssuedAt().setExpirationTime("2m").setProtectedHeader({ alg: "EdDSA" }).sign(f.keys[0].privateKey);
  async function participant(task, key = 0, connect = true) {
    const human = task === "human", proof = testDevice(), context = { ...join, displayName: human ? "Synthetic Human" : join.displayName };
    const response = await post(human ? "/api/sessions" : "/api/machine/sessions", human ? humanToken : await f.token({ taskId: task }, key),
      { ...context, deviceProof: proof(context), machineReceiveVersion: 1 });
    assert.equal(response.status, 201); const body = await response.json();
    if (!connect) return { body };
    const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
    t.after(() => socket.terminate());
    await new Promise((resolve, reject) => { socket.once("message", resolve); socket.once("error", reject); });
    return { body, socket, proof };
  }
  const human = await participant("human"), retired = await participant("retired"), survivor = await participant("survivor", 1);
  const pending = await participant("pending", 0, false);
  assert.equal(app.registry.participantCount, 3);
  writeFileSync(file + ".next", JSON.stringify({ ...f.profile, revision: 2, keys: [f.profile.keys[1]] }));
  renameSync(file + ".next", file);
  assert.equal(app.reloadMachineTrust().status, "updated");
  assert.equal(app.registry.participantCount, 2, "membership is revoked before the reload ACK");
  assert.equal(app.registry.members(join.roomId).filter(member => member.machine).length, 1);
  assert.equal(human.socket.readyState, WebSocket.OPEN); assert.equal(survivor.socket.readyState, WebSocket.OPEN);
  const denied = new WebSocket(base.replace("http", "ws") + pending.body.signalingPath, { origin: base });
  denied.on("error", () => {}); t.after(() => denied.terminate());
  const status = await new Promise(resolve => denied.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); denied.terminate(); }));
  assert.equal(status, 401);
  const lease = survivor.body.machineLease;
  const renewed = await post("/api/machine/sessions/renew", await f.token({ taskId: "survivor", exp: f.now + 240 }, 1), {
    roomId: join.roomId, sessionId: lease.sessionId, expectedGeneration: 1,
    deviceProof: survivor.proof({ ...join, machineSessionId: lease.sessionId, expectedGeneration: 1 }),
  });
  assert.equal(renewed.status, 200); assert.equal((await renewed.json()).generation, 2);
  writeFileSync(file, "private-invalid-canary");
  assert.deepEqual(app.reloadMachineTrust(), { schema: "ananta.meet-trust-reload.v1", status: "blocked" });
  assert.equal(app.registry.participantCount, 1); assert.equal(app.registry.members(join.roomId)[0].machine, false);
  assert.equal(human.socket.readyState, WebSocket.OPEN);
  const capability = await (await fetch(base + "/api/machine/capabilities")).json();
  assert.equal(capability.admissionEnabled, false);
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.doesNotMatch(JSON.stringify(capability), /private-invalid|synthetic-|public.json/);
  retired.socket.terminate();
});
