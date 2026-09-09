import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.js";
import { deviceProofMessage } from "../src/device-proof.js";

test("actual authenticated retirement removes only the old membership before permitting a new ticket", { timeout: 12000 }, async t => {
  const hub = generateKeyPairSync("ed25519"), issuer = "https://synthetic-hub.test";
  const context = { roomId: "room-0123456789abcdef01", mode: "room", displayName: "Ananta (KI)" };
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
  const token = (taskId, changes = {}) => new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v2", sub: "ananta",
    jti: randomBytes(16).toString("hex"), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
    roomId: context.roomId, taskId, tenantId: "tenant", projectId: "project", runtimeId: taskId + "-runtime",
    sessionId: taskId + "-session", capabilities: ["screen.publish"], ...changes,
  }).setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" }).sign(hub.privateKey);
  const post = (path, grant, input, headers = {}) => fetch(base + "/api/machine/sessions" + path, {
    method: "POST", signal: AbortSignal.timeout(2000),
    headers: { "content-type": "application/json", Authorization: `Bearer ${grant}`, ...headers },
    body: JSON.stringify(input),
  });
  async function join(taskId) {
    const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const timestamp = Date.now(), nonce = randomBytes(24).toString("base64url");
    const deviceProof = { timestamp, nonce, publicKey: device.publicKey.export({ format: "jwk" }),
      signature: sign("sha256", Buffer.from(deviceProofMessage({ ...context, timestamp, nonce })),
        { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
    const response = await post("", await token(taskId), { ...context, deviceProof, machineReceiveVersion: 1 });
    assert.equal(response.status, 201); const body = await response.json();
    const socket = new WebSocket(base.replace("http:", "ws:") + body.signalingPath, { origin: base });
    sockets.push(socket);
    const welcome = await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("message", raw => {
        const message = JSON.parse(raw); if (message.type === "welcome") resolve(message); else reject(new Error("test_welcome_required"));
      });
    });
    return { socket, peerId: welcome.peerId, input: { roomId: context.roomId,
      sessionId: body.machineLease.sessionId, nonce: "a".repeat(32) } };
  }
  const first = await join("first"), second = await join("second");
  const retire = async (who = "first", input = first.input, changes = {}) => post("/retire", await token(who, changes), input);
  for (const changes of [{ tenantId: "other" }, { projectId: "other" }, { runtimeId: "other" },
    { sessionId: "other" }, { capabilities: ["chat.read"] }, { exp: 1 }]) {
    assert.equal((await retire("first", first.input, changes)).status, 401);
    assert.equal(app.registry.participantCount, 2);
  }
  assert.equal((await retire("second")).status, 401);
  assert.equal((await retire("first", { ...first.input, force: true })).status, 400);
  assert.equal((await post("/retire", await token("first"), first.input, { origin: "https://foreign.test" })).status, 400);
  const response = await retire(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store"); const receipt = await response.json();
  assert.deepEqual(Object.keys(receipt).sort(), ["schema", "nonce", "sessionId", "binding", "retired"].sort());
  assert.equal(receipt.schema, "ananta.meet-session-retired.v1"); assert.equal(receipt.retired, true);
  assert.equal(receipt.sessionId, first.input.sessionId); assert.equal(receipt.nonce, first.input.nonce);
  assert.deepEqual(app.registry.members(context.roomId).map(p => p.id), [second.peerId]);
  assert.equal((await post("/authorization", await token("first"), first.input)).status, 401);
  const replacement = await join("first");
  assert.notEqual(replacement.input.sessionId, first.input.sessionId); assert.notEqual(replacement.peerId, first.peerId);
  assert.equal(app.registry.participantCount, 2);
  assert.deepEqual(await (await retire()).json(), receipt);
  assert.equal(app.registry.participantCount, 2);
  assert.equal((await post("/authorization", await token("first"), replacement.input)).status, 200);
  const once = await token("first");
  assert.equal((await post("/retire", once, replacement.input)).status, 200);
  assert.equal((await post("/retire", once, replacement.input)).status, 401);
  assert.deepEqual(app.registry.members(context.roomId).map(p => p.id), [second.peerId]);
});
