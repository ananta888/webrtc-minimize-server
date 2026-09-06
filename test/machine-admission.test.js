import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { MachineAdmission, machineMessageAllowed } from "../src/machine-admission.js";
import { createAppServer } from "../src/server.js";
import { WebSocket } from "ws";
import { deviceProofMessage } from "../src/device-proof.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
const issuer = "https://hub.example.test";
const now = Date.now();
const join = { roomId: "room-0123456789abcdef01", mode: "room", displayName: "Ananta (KI)" };

async function grant(changes = {}, key = keys.privateKey) {
  return new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v1", sub: "ananta", jti: "lease-1",
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 120,
    roomId: join.roomId, taskId: "task-1", tenantId: "tenant", projectId: "project", ...changes,
  }).setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine+jwt" }).sign(key);
}

test("machine admission is default denied and never accepts a service token", async () => {
  await assert.rejects(new MachineAdmission().verify("Bearer abc", join, now), /disabled/);
  await assert.rejects(new MachineAdmission({ publicKey, issuer }).verify("Bearer abc", join, now), /invalid/);
});

test("operator-pinned grant remains scoped, visibly synthetic and one-use", async () => {
  const admission = new MachineAdmission({ publicKey, issuer });
  const token = await grant();
  const identity = await admission.verify(`Bearer ${token}`, join, now);
  assert.equal(identity.displayName, "Ananta (KI)");
  assert.equal(identity.subject, "machine:ananta");
  assert.equal(identity.machineExpiresAt, (Math.floor(now / 1000) + 120) * 1000);
  await assert.rejects(admission.verify(`Bearer ${token}`, join, now), /invalid/);
});

for (const change of [{ aud: "human-client" }, { iss: "https://evil.test" }, { exp: 1 },
  { exp: Math.floor(now / 1000) + 601 }, { iat: Math.floor(now / 1000) + 20 }, { taskId: null },
  { projectId: "../other" }, { roomId: "room-111111111111111111" }, { extra: true }]) {
  test(`rejects machine grant mutation ${Object.keys(change)[0]} ${JSON.stringify(change)}`, async () => {
    await assert.rejects(new MachineAdmission({ publicKey, issuer }).verify(`Bearer ${await grant(change)}`, join, now), /invalid/);
  });
}

test("does not upgrade pair, name, key or scope", async () => {
  const token = await grant();
  for (const input of [{ ...join, mode: "pair" }, { ...join, displayName: "Human" }]) {
    await assert.rejects(new MachineAdmission({ publicKey, issuer }).verify(`Bearer ${token}`, input, now), /invalid/);
  }
  const other = generateKeyPairSync("ed25519");
  await assert.rejects(new MachineAdmission({ publicKey, issuer }).verify(`Bearer ${await grant({}, other.privateKey)}`, join, now), /invalid/);
  assert.equal(machineMessageAllowed({ type: "media-state", source: "screen" }), false);
  assert.equal(machineMessageAllowed({ type: "media-agent-consent", enabled: true }), false);
  assert.equal(machineMessageAllowed({ type: "relay-consent", enabled: true }), false);
  assert.equal(machineMessageAllowed({ type: "media-state", source: "camera" }), true);
  assert.equal(machineMessageAllowed({ type: "overlay-key" }), true);
});

test("machine HTTP admission preserves device proof and human auth, expires WebSocket", { timeout: 10_000 }, async context => {
  let proofChecks = 0;
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0,
    authMode: "required", machineHubPublicKey: publicKey, machineHubIssuer: issuer,
    oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks",
    stunUrls: [], turnServers: [], mediaE2eeMode: "required",
  }, deviceProofVerifier: { verify(input) {
    ++proofChecks; assert.equal(input, "synthetic-proof"); return { fingerprint: "test-device" };
  } } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  context.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const human = await fetch(base + "/api/sessions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...join, deviceProof: "synthetic-proof", machineReceiveVersion: 1 }) });
  assert.equal(human.status, 401); assert.equal(proofChecks, 0);
  const expiry = Math.floor(Date.now() / 1000) + 3;
  const response = await fetch(base + "/api/machine/sessions", { method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${await grant({ exp: expiry })}` },
    body: JSON.stringify({ ...join, deviceProof: "synthetic-proof", machineReceiveVersion: 1 }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(proofChecks, 1); assert.equal(body.machineExpiresAt, expiry * 1000);
  const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
  context.after(() => socket.terminate());
  const closed = await new Promise(resolve => socket.once("close", (code, reason) => resolve([code, reason.toString()])));
  assert.deepEqual(closed, [1008, "machine_session_expired"]);
});

test("v2 capabilities are explicit, closed and bound into renewal identity", async () => {
  const value = { iss: issuer, aud: "ananta-meet-machine-v2", sub: "dialog", jti: "v2-session",
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 120, roomId: join.roomId,
    taskId: "task", tenantId: "tenant", projectId: "project", runtimeId: "runtime", sessionId: "hub-session",
    capabilities: ["audio.receive", "chat.read", "chat.send"] };
  const token = input => new SignJWT(input).setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" }).sign(keys.privateKey);
  const admission = new MachineAdmission({ publicKey, issuer });
  const identity = await admission.verify(`Bearer ${await token(value)}`, join, now);
  assert.equal(identity.machineBinding.runtimeId, "runtime");
  assert.equal(identity.machineBinding.hubSessionId, "hub-session");
  assert.equal(identity.machineBinding.capabilitySet, "audio.receive,chat.read,chat.send");
  assert.equal(machineMessageAllowed({ type: "media-state", source: "screen", active: true }, identity.machineCapabilities), false);
  assert.equal(machineMessageAllowed({ type: "media-state", source: "screen", active: false }, identity.machineCapabilities), true);
  for (const patch of [{ capabilities: ["record"] }, { capabilities: ["chat.read", "chat.read"] },
    { capabilities: [] }, { runtimeId: null }, { tools: true }, { aud: "ananta-meet-machine-v1" }]) {
    await assert.rejects(new MachineAdmission({ publicKey, issuer }).verify(`Bearer ${await token({ ...value, ...patch })}`, join, now), /invalid/);
  }
});

test("v2 scope and publisher receipts cross real HTTP/WebSocket boundaries without content", { timeout: 8000 }, async t => {
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    machineHubPublicKey: publicKey, machineHubIssuer: issuer, oidcIssuer: issuer,
    oidcAudience: "human", oidcJwksUrl: issuer + "/jwks", stunUrls: [], turnServers: [], mediaE2eeMode: "required" },
    oidcVerifier: { verify: async () => ({ issuer, subject: "human", displayName: "Human" }) },
    deviceProofVerifier: { verify: value => ({ fingerprint: value }) } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = await new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v2", sub: "dialog", jti: "wire-v2",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
    roomId: join.roomId, taskId: "task", tenantId: "tenant", projectId: "project",
    runtimeId: "runtime", sessionId: "hub-session", capabilities: ["audio.receive", "chat.read", "chat.send"] })
    .setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" }).sign(keys.privateKey);
  const connect = async (machine, authorization) => {
    const response = await fetch(base + (machine ? "/api/machine/sessions" : "/api/sessions"), {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${authorization}` },
      body: JSON.stringify({ ...join, displayName: machine ? "Ananta (KI)" : "Human", machineReceiveVersion: 1,
        deviceProof: machine ? "machine-device" : "human-device" }) });
    assert.equal(response.status, 201); const body = await response.json();
    const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
    t.after(() => socket.terminate());
    const messages = []; socket.on("message", raw => messages.push(JSON.parse(raw)));
    const waitFor = async predicate => {
      const deadline = Date.now() + 2000;
      while (!messages.some(predicate)) {
        assert.ok(Date.now() < deadline, "bounded synthetic signaling receipt timeout");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return messages.find(predicate);
    };
    const welcome = await waitFor(message => message.type === "welcome");
    return { body, socket, welcome, waitFor };
  };
  const human = await connect(false, "synthetic-human"), machine = await connect(true, token);
  assert.equal(human.body.machineContext, undefined);
  assert.deepEqual(machine.body.machineContext, { schema: "ananta.meet-machine-context.v1", tenantId: "tenant",
    projectId: "project", taskId: "task", runtimeId: "runtime", hubSessionId: "hub-session" });
  assert.equal(machine.welcome.machine, true);
  const initial = await machine.waitFor(message => message.type === "machine-receive-state");
  assert.deepEqual(initial.grants, []);
  human.socket.send(JSON.stringify({ type: "media-state", source: "microphone", active: true, trackId: "human-mic" }));
  human.socket.send(JSON.stringify({ type: "machine-receive-consent", trigger: "user-action", machinePeerId: machine.welcome.peerId,
    expectedRevision: 0, publicationIds: ["human-mic"], chatRead: true, expiresAt: Date.now() + 60_000 }));
  const granted = await machine.waitFor(message => message.type === "machine-receive-state" && message.revision === 1);
  assert.equal(granted.grants[0].publisherPeerId, human.welcome.peerId);
  assert.equal(Object.keys(granted.grants[0]).includes("text"), false);
  const inspectToken = await new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v2", sub: "dialog", jti: "inspect-v2",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, roomId: join.roomId,
    taskId: "task", tenantId: "tenant", projectId: "project", runtimeId: "runtime", sessionId: "hub-session",
    capabilities: ["audio.receive", "chat.read", "chat.send"] })
    .setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt" }).sign(keys.privateKey);
  const inspect = () => fetch(base + "/api/machine/sessions/authorization", { method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${inspectToken}` },
    body: JSON.stringify({ roomId: join.roomId, sessionId: machine.body.machineLease.sessionId, nonce: "a".repeat(32) }) });
  const receipt = await inspect(); assert.equal(receipt.status, 200);
  const authorization = await receipt.json();
  assert.equal(authorization.schema, "ananta.meet-authorization.v1");
  assert.equal(authorization.nonce, "a".repeat(32)); assert.equal(authorization.peerId, machine.welcome.peerId);
  assert.deepEqual(authorization.grants, granted.grants); assert.equal(authorization.receiveRevision, 1);
  assert.deepEqual(authorization.publications, [{ peerId: human.welcome.peerId, publicationId: "human-mic",
    source: "microphone", publicationEpoch: 1 }]);
  assert.equal((await inspect()).status, 401);
  machine.socket.send(JSON.stringify({ type: "machine-receive-consent", trigger: "user-action", machinePeerId: machine.welcome.peerId,
    expectedRevision: 1, publicationIds: [], chatRead: true, expiresAt: Date.now() + 60_000 }));
  assert.equal((await machine.waitFor(message => message.type === "error")).code, "machine_operation_denied");
  human.socket.send(JSON.stringify({ type: "media-state", source: "microphone", active: false }));
  assert.deepEqual((await machine.waitFor(message => message.type === "machine-receive-state" && message.revision === 2)).grants, []);
});

test("real device-bound machine renewal retains one WebSocket and rejects scope/replay", { timeout: 10_000 }, async t => {
  const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const proof = context => {
    const timestamp = Date.now(), nonce = randomBytes(24).toString("base64url");
    return { publicKey: device.publicKey.export({ format: "jwk" }), timestamp, nonce,
      signature: sign("sha256", Buffer.from(deviceProofMessage({ ...context, timestamp, nonce })),
        { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    machineHubPublicKey: publicKey, machineHubIssuer: issuer, oidcIssuer: issuer,
    oidcAudience: "human", oidcJwksUrl: issuer + "/jwks", stunUrls: [], turnServers: [], mediaE2eeMode: "required" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, token, body) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  t.after(() => app.server.close());
  const start = await post("/api/machine/sessions", await grant({ jti: "renew-start" }), { ...join, deviceProof: proof(join), machineReceiveVersion: 1 });
  assert.equal(start.status, 201);
  const body = await start.json(); let lease = body.machineLease;
  const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
  t.after(() => socket.terminate());
  await new Promise(resolve => socket.once("message", resolve));
  const peer = app.registry.members(join.roomId)[0];
  for (let i = 0; i < 3; i++) {
    const input = { roomId: join.roomId, sessionId: lease.sessionId, expectedGeneration: lease.generation };
    const token = await grant({ jti: `renew-${i}`, exp: Math.floor(now / 1000) + 180 + i * 60 });
    const response = await post("/api/machine/sessions/renew", token, { ...input,
      deviceProof: proof({ ...join, machineSessionId: lease.sessionId, expectedGeneration: lease.generation }) });
    assert.equal(response.status, 200); lease = await response.json();
    assert.equal(lease.generation, i + 2); assert.equal(app.registry.participantCount, 1);
    assert.equal(app.registry.members(join.roomId)[0], peer);
  }
  const input = { roomId: join.roomId, sessionId: lease.sessionId, expectedGeneration: lease.generation };
  // A fresh join signature is not a renewal signature for this session/generation.
  const wrongProof = await post("/api/machine/sessions/renew", await grant({ jti: "wrong-proof", exp: Math.floor(now / 1000) + 400 }),
    { ...input, deviceProof: proof(join) });
  assert.equal(wrongProof.status, 400);
  const wrongScope = await post("/api/machine/sessions/renew", await grant({ jti: "wrong-task", taskId: "other", exp: Math.floor(now / 1000) + 400 }),
    { ...input, deviceProof: proof({ ...join, machineSessionId: lease.sessionId, expectedGeneration: lease.generation }) });
  assert.equal(wrongScope.status, 401);
  const replay = await post("/api/machine/sessions/renew", await grant({ jti: "renew-2", exp: Math.floor(now / 1000) + 400 }),
    { ...input, deviceProof: proof({ ...join, machineSessionId: lease.sessionId, expectedGeneration: lease.generation }) });
  assert.equal(replay.status, 401);
});
