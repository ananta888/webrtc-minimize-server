import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { MachineAdmission, machineMessageAllowed } from "../src/machine-admission.js";
import { createAppServer } from "../src/server.js";
import { WebSocket } from "ws";

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
    body: JSON.stringify({ ...join, deviceProof: "synthetic-proof" }) });
  assert.equal(human.status, 401); assert.equal(proofChecks, 0);
  const expiry = Math.floor(Date.now() / 1000) + 3;
  const response = await fetch(base + "/api/machine/sessions", { method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${await grant({ exp: expiry })}` },
    body: JSON.stringify({ ...join, deviceProof: "synthetic-proof" }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(proofChecks, 1); assert.equal(body.machineExpiresAt, expiry * 1000);
  const socket = new WebSocket(base.replace("http", "ws") + body.signalingPath, { origin: base });
  context.after(() => socket.terminate());
  const closed = await new Promise(resolve => socket.once("close", (code, reason) => resolve([code, reason.toString()])));
  assert.deepEqual(closed, [1008, "machine_session_expired"]);
});
