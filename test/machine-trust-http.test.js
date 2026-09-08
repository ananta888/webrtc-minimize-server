import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.js";
import { trustFixture, testDevice, join, issuer } from "./helpers/machine-trust.mjs";

async function start(t, profile) {
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    machineHubTrustProfile: profile, oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks",
    stunUrls: [], turnServers: [], mediaE2eeMode: "required" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, token, input) => fetch(base + path, { method: "POST", signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
  return { app, base, post };
}

test("real P-256 machine keeps one membership through three cross-key renewals; replay and foreign trust fail", { timeout: 12000 }, async t => {
  const f = trustFixture(), { app, base, post } = await start(t, f.profile), proof = testDevice();
  const capability = await (await fetch(base + "/api/machine/capabilities", { signal: AbortSignal.timeout(3000) })).json();
  assert.equal(capability.admissionEnabled, true);
  assert.equal(JSON.stringify(capability).includes(f.profile.keys[0].x), false);
  const input = () => ({ ...join, deviceProof: proof(join), machineReceiveVersion: 1 });
  assert.equal((await post("/api/sessions", await f.token(), input())).status, 401);
  for (const changes of [{ tenantId: "foreign" }, { projectId: "foreign" }, { sub: "foreign" }, { capabilities: ["audio.receive"] }]) {
    assert.equal((await post("/api/machine/sessions", await f.token(changes), input())).status, 401);
  }
  assert.equal(app.registry.participantCount, 0);
  const joined = await post("/api/machine/sessions", await f.token(), input());
  assert.equal(joined.status, 201); const body = await joined.json(); let lease = body.machineLease;
  const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once("message", resolve); socket.once("error", reject); });
  const peer = app.registry.members(join.roomId)[0];
  assert.equal(app.registry.participantCount, 1);
  for (let index = 0; index < 3; index++) {
    const scope = { roomId: join.roomId, sessionId: lease.sessionId, expectedGeneration: lease.generation };
    const token = await f.token({ exp: f.now + 180 + index * 60 }, index % 2);
    const renewal = { ...scope, deviceProof: proof({ ...join, machineSessionId: lease.sessionId, expectedGeneration: lease.generation }) };
    const response = await post("/api/machine/sessions/renew", token, renewal);
    assert.equal(response.status, 200); lease = await response.json();
    assert.equal(lease.generation, index + 2);
    assert.equal(app.registry.participantCount, 1); assert.equal(app.registry.members(join.roomId)[0], peer);
    assert.equal((await post("/api/machine/sessions/renew", token, renewal)).status, 401);
  }
  const observation = { roomId: join.roomId, sessionId: lease.sessionId, nonce: "a".repeat(32) };
  const viewed = await post("/api/machine/sessions/observation", await f.token({}, 1), observation);
  assert.equal(viewed.status, 200); const snapshot = await viewed.json();
  assert.equal(snapshot.peerId, peer.id); assert.equal(snapshot.lease.generation, 4);
  assert.equal(snapshot.binding.subject, "machine:ananta"); assert.deepEqual(snapshot.publications, []);
  const receive = await post("/api/machine/sessions/authorization", await f.token({}, 1), observation);
  assert.equal(receive.status, 200); assert.deepEqual((await receive.json()).grants, []);
  app.registry.leave(peer);
  assert.equal((await post("/api/machine/sessions/observation", await f.token({}, 1), observation)).status, 401);
});

test("profile replacement removes the old key and has no surviving membership to renew", { timeout: 8000 }, async t => {
  const f = trustFixture(), proof = testDevice();
  const removed = { ...f.profile, revision: 2, keys: [f.profile.keys[1]] };
  const { app, post } = await start(t, removed);
  const input = () => ({ ...join, deviceProof: proof(join), machineReceiveVersion: 1 });
  assert.equal((await post("/api/machine/sessions", await f.token(), input())).status, 401);
  assert.equal(app.registry.participantCount, 0);
  assert.equal((await post("/api/machine/sessions", await f.token({}, 1), input())).status, 201);
  const fake = { roomId: join.roomId, sessionId: "ms_" + "a".repeat(32), nonce: "b".repeat(32) };
  assert.equal((await post("/api/machine/sessions/observation", await f.token({}, 1), fake)).status, 401);
});

test("explicit empty profile advertises admission disabled without trusting the plan", { timeout: 5000 }, async t => {
  const f = trustFixture(), { base, post } = await start(t, { ...f.profile, scopes: [] });
  const response = await fetch(base + "/api/machine/capabilities", { signal: AbortSignal.timeout(3000) });
  assert.equal((await response.json()).admissionEnabled, false);
  assert.equal((await post("/api/machine/sessions", await f.token(),
    { ...join, deviceProof: testDevice()(join), machineReceiveVersion: 1 })).status, 401);
});
