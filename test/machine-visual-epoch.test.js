import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.js";

test("visual-capable recipients get only server-issued publication epochs; audio-only wire stays unchanged", { timeout: 10_000 }, async t => {
  const keys = generateKeyPairSync("ed25519"), issuer = "https://synthetic.example.test";
  const roomId = "room-0123456789abcdef01";
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    machineHubPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }), machineHubIssuer: issuer,
    oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks", stunUrls: [], turnServers: [], mediaE2eeMode: "required" },
    oidcVerifier: { verify: async () => ({ issuer, subject: "human", displayName: "Synthetic human" }) },
    deviceProofVerifier: { verify: value => ({ fingerprint: value }) } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close()); const base = `http://127.0.0.1:${app.server.address().port}`;
  async function connect(capability) {
    const name = capability || "human", timestamp = Math.floor(Date.now() / 1000);
    const token = capability ? await new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v2", sub: name, jti: name,
      // These are independent Hub assignments, not two devices duplicating one Task.
      iat: timestamp, exp: timestamp + 120, roomId, taskId: `task-${name}`, tenantId: "tenant", projectId: "project",
      runtimeId: name, sessionId: name, capabilities: [capability] })
      .setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" }).sign(keys.privateKey) : "synthetic-human";
    const response = await fetch(base + (capability ? "/api/machine/sessions" : "/api/sessions"), {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ roomId, mode: "room", displayName: capability ? "Ananta (KI)" : "Synthetic human",
        machineReceiveVersion: 1, deviceProof: name }) });
    assert.equal(response.status, 201); const body = await response.json();
    const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
    t.after(() => socket.terminate()); const messages = [];
    socket.on("message", raw => messages.push(JSON.parse(raw)));
    const waitFor = async predicate => {
      const deadline = Date.now() + 2000;
      while (!messages.some(predicate)) { assert.ok(Date.now() < deadline, "bounded synthetic receipt timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
      return messages.find(predicate);
    };
    return { socket, messages, waitFor, welcome: await waitFor(message => message.type === "welcome") };
  }
  const human = await connect(), visual = await connect("video.receive"), audio = await connect("audio.receive");
  const announce = (active, trackId = "camera") => human.socket.send(JSON.stringify({ type: "media-state",
    source: "camera", active, ...(active ? { trackId, publicationEpoch: 987654 } : {}) }));
  announce(true);
  const first = await visual.waitFor(message => message.type === "media-state" && message.active);
  assert.equal(first.publicationEpoch, 1);
  assert.equal(first.publicationEpoch, app.registry.publication(human.welcome.peerId, "camera", roomId).publicationEpoch);
  assert.equal(Object.hasOwn(await audio.waitFor(message => message.type === "media-state" && message.active), "publicationEpoch"), false);
  visual.messages.length = 0; announce(true);
  assert.equal((await visual.waitFor(message => message.type === "media-state" && message.active)).publicationEpoch, 1);
  announce(false); await visual.waitFor(message => message.type === "media-state" && !message.active);
  visual.messages.length = 0; announce(true);
  assert.equal((await visual.waitFor(message => message.type === "media-state" && message.active)).publicationEpoch, 2);
});
