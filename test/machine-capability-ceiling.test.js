import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { MachineAdmission } from "../src/machine-admission.js";
import { MACHINE_CAPABILITIES, machineCapabilityEnvironment } from "../src/machine-capabilities.js";
import { loadConfig } from "../src/config.js";

test("operator capability ceiling is closed, explicit, immutable and empty means deny-all", () => {
  assert.deepEqual(machineCapabilityEnvironment(undefined), [...MACHINE_CAPABILITIES].sort());
  assert.deepEqual(machineCapabilityEnvironment(""), []);
  assert.deepEqual(loadConfig({ MACHINE_ALLOWED_CAPABILITIES: "chat.read,chat.send" }).machineAllowedCapabilities, ["chat.read", "chat.send"]);
  assert.ok(Object.isFrozen(machineCapabilityEnvironment("chat.read")));
  for (const value of [null, "chat.read,chat.read", "chat.read,", "record", "a".repeat(201)]) {
    assert.throws(() => machineCapabilityEnvironment(value), /machine_capability_ceiling_invalid/);
  }
});

test("valid Hub grants cannot exceed the operator ceiling, including legacy combined publication", async () => {
  const keys = generateKeyPairSync("ed25519"), issuer = "https://synthetic-hub.example.test";
  const join = { roomId: "room-aaaaaaaaaaaaaaaaaa", mode: "room", displayName: "Ananta (KI)" };
  const now = Math.floor(Date.now() / 1000);
  const token = (caps, version = 2) => new SignJWT({ iss: issuer, aud: `ananta-meet-machine-v${version}`,
    sub: "machine", iat: now, exp: now + 120, jti: "synthetic", roomId: join.roomId, taskId: "task",
    tenantId: "tenant", projectId: "project", ...(version === 2 ? { runtimeId: "runtime", sessionId: "session", capabilities: caps } : {}) })
    .setProtectedHeader({ alg: "EdDSA", typ: version === 2 ? "ananta-meet-machine-v2+jwt" : "ananta-meet-machine+jwt" }).sign(keys.privateKey);
  const admission = allowedCapabilities => new MachineAdmission({ issuer, allowedCapabilities,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) });
  const chatOnly = admission(["chat.read", "chat.send"]);
  await assert.rejects(chatOnly.verify("Bearer " + await token(["chat.read", "screen.publish"]), join), /machine_grant_invalid/);
  await assert.rejects(chatOnly.verify("Bearer " + await token([], 1), join), /machine_grant_invalid/);
  const identity = await chatOnly.verify("Bearer " + await token(["chat.read", "chat.send"]), join);
  assert.deepEqual(identity.machineCapabilities, ["chat.read", "chat.send"]);
  await assert.rejects(admission([]).verify("Bearer " + await token(["chat.send"]), join), /machine_grant_invalid/);
});
