import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { WebSocket } from "ws";
import { deviceProofMessage } from "../src/device-proof.js";
import { createAppServer } from "../src/server.js";

test("real signed HTTP admission cannot double-dispatch one v2 Task across devices", { timeout: 10000 }, async t => {
  const hub = generateKeyPairSync("ed25519"), issuer = "https://synthetic-hub.example.test";
  const devices = [0, 1].map(() => generateKeyPairSync("ec", { namedCurve: "prime256v1" }));
  const join = { roomId: "room-0123456789abcdef01", mode: "room", displayName: "Ananta (KI)" };
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    machineHubPublicKey: hub.publicKey.export({ type: "spki", format: "pem" }), machineHubIssuer: issuer,
    oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks",
    stunUrls: [], turnServers: [], mediaE2eeMode: "required" } });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise(resolve => app.webSocketServer.close(resolve));
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function admit(device, changes = {}) {
    const issued = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v2", sub: "dialog",
      jti: randomBytes(16).toString("hex"), iat: issued, exp: issued + 120,
      roomId: join.roomId, taskId: "task-one", tenantId: "tenant", projectId: "project",
      runtimeId: "runtime-one", sessionId: "hub-session-one", capabilities: ["chat.read", "chat.send"], ...changes,
    }).setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" }).sign(hub.privateKey);
    const timestamp = Date.now(), nonce = randomBytes(24).toString("base64url");
    const deviceProof = { timestamp, nonce, publicKey: device.publicKey.export({ format: "jwk" }),
      signature: sign("sha256", Buffer.from(deviceProofMessage({ ...join, timestamp, nonce })),
        { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
    return fetch(base + "/api/machine/sessions", { method: "POST", signal: AbortSignal.timeout(2000),
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...join, deviceProof, machineReceiveVersion: 1 }) });
  }
  async function connect(body) {
    const socket = new WebSocket(base.replace("http:", "ws:") + body.signalingPath, { origin: base });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("message", value => {
        const message = JSON.parse(String(value));
        if (message.type === "welcome") resolve(); else reject(new Error("test_welcome_required"));
      });
    });
  }
  const responses = await Promise.all(devices.map(device => admit(device)));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.deepEqual(await responses.find(response => response.status === 409).json(), { error: "machine_session_already_active" });
  await connect(await responses.find(response => response.status === 201).json());
  assert.equal(app.registry.participantCount, 1);
  const originalPeer = app.registry.members(join.roomId)[0];
  for (const changes of [{ runtimeId: "runtime-two" }, { sessionId: "hub-session-two" }, { capabilities: ["chat.read"] }]) {
    const duplicate = await admit(devices[1], changes);
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "machine_session_already_active" });
    assert.equal(app.registry.members(join.roomId)[0], originalPeer);
    assert.equal(app.registry.participantCount, 1);
  }
  const independent = await admit(devices[1], { taskId: "task-two" });
  assert.equal(independent.status, 201); await connect(await independent.json());
  assert.equal(app.registry.participantCount, 2);
});
