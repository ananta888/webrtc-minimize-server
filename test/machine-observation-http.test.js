import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.js";
import { deviceProofMessage } from "../src/device-proof.js";

test("real scoped grants observe only their machine's publications and cannot survive revocation", { timeout: 15000 }, async t => {
  const keys = generateKeyPairSync("ed25519"), issuer = "https://synthetic-hub.test";
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    machineHubPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }), machineHubIssuer: issuer,
    oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks",
    stunUrls: [], turnServers: [], mediaE2eeMode: "required" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`, roomId = "room-0123456789abcdef01";
  const token = (taskId, changes = {}) => new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v2", sub: "ananta",
    jti: randomBytes(16).toString("hex"), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
    roomId, taskId, tenantId: "tenant", projectId: "project", runtimeId: taskId + "-runtime", sessionId: taskId + "-session",
    capabilities: ["screen.publish"], ...changes }).setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" })
    .sign(keys.privateKey);
  const post = (path, grant, input) => fetch(base + "/api/machine/sessions" + path, { method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${grant}` }, body: JSON.stringify(input) });
  const connect = async taskId => {
    const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const context = { roomId, mode: "room", displayName: "Ananta (KI)" }, timestamp = Date.now();
    const nonce = randomBytes(24).toString("base64url");
    const deviceProof = { publicKey: device.publicKey.export({ format: "jwk" }), timestamp, nonce,
      signature: sign("sha256", Buffer.from(deviceProofMessage({ ...context, timestamp, nonce })),
        { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
    const response = await post("", await token(taskId), { ...context, deviceProof, machineReceiveVersion: 1 });
    assert.equal(response.status, 201); const joined = await response.json();
    const socket = new WebSocket(base.replace("http", "ws") + joined.signalingPath, { origin: base });
    t.after(() => socket.terminate());
    const welcome = await new Promise((resolve, reject) => {
      socket.on("message", raw => { const message = JSON.parse(raw); if (message.type === "welcome") resolve(message); });
      socket.once("error", reject);
    });
    return { socket, peer: app.registry.members(roomId).find(peer => peer.id === welcome.peerId),
      input: { roomId, sessionId: joined.machineLease.sessionId, nonce: "a".repeat(32) } };
  };
  const first = await connect("first"), second = await connect("second");
  const observe = async (who = "first", input = first.input, changes = {}) =>
    post("/observation", await token(who, changes), input);
  const initial = await observe(); assert.equal(initial.status, 200);
  const idle = await initial.json();
  assert.deepEqual(Object.keys(idle).sort(), ["schema", "nonce", "lease", "binding", "peerId", "roomId",
    "membershipEpoch", "publicationRevision", "publications"].sort());
  assert.equal(idle.schema, "ananta.meet-session-observation.v1"); assert.equal(idle.publicationRevision, 0);
  assert.deepEqual(idle.publications, []); assert.equal(initial.headers.get("cache-control"), "no-store");
  for (const [machine, trackId] of [[first, "own-screen"], [second, "foreign-screen"]]) {
    machine.socket.send(JSON.stringify({ type: "media-state", source: "screen", active: true, trackId }));
  }
  const until = Date.now() + 2000;
  while (first.peer.publicationRevision !== 1 || second.peer.publicationRevision !== 1) {
    assert.ok(Date.now() < until, "bounded synthetic media-state timeout");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const active = await (await observe()).json();
  assert.equal(active.peerId, first.peer.id); assert.equal(active.publicationRevision, 1);
  assert.deepEqual(active.publications, [{ publicationId: "own-screen", source: "screen", publicationEpoch: 1 }]);
  assert.equal((await observe("second")).status, 401);
  for (const changes of [{ tenantId: "foreign" }, { projectId: "foreign" }, { runtimeId: "foreign" }, { exp: 1 }]) {
    assert.equal((await observe("first", first.input, changes)).status, 401);
  }
  assert.equal((await observe("first", { ...first.input, source: "camera" })).status, 400);
  const repeated = await token("first");
  assert.equal((await post("/observation", repeated, first.input)).status, 200);
  assert.equal((await post("/observation", repeated, first.input)).status, 401);
  const legacy = await post("/authorization", await token("first"), first.input);
  assert.equal(legacy.status, 200); const previous = await legacy.json();
  assert.equal(previous.schema, "ananta.meet-authorization.v1"); assert.equal(previous.publicationRevision, undefined);
  assert.deepEqual(previous.publications, []);
  app.registry.leave(first.peer);
  assert.equal((await observe()).status, 401);
});
