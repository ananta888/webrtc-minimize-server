import assert from "node:assert/strict";
import { sign } from "node:crypto";
import test from "node:test";
import { MachineAdmission } from "../src/machine-admission.js";
import { trustFixture, join } from "./helpers/machine-trust.mjs";

test("profile selects two real signing keys without changing the exact session identity", async () => {
  const f = trustFixture(), admission = new MachineAdmission({ trustProfile: f.profile });
  const first = await admission.verify(`Bearer ${await f.token()}`, join, f.now * 1000);
  const next = await admission.verify(`Bearer ${await f.token({}, 1)}`, join, f.now * 1000);
  assert.deepEqual(next, first);
  assert.deepEqual(first.machineCapabilities, ["chat.read", "chat.send"]);
  assert.equal(first.subject, "machine:ananta"); assert.equal(first.machineBinding.tenantId, "tenant");
  assert.equal(Object.hasOwn(first, "trustProfile"), false);
});

for (const field of ["tenantId", "projectId", "sub"]) test(`valid signature cannot expand profile ${field}`, async () => {
  const f = trustFixture();
  await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(
    `Bearer ${await f.token({ [field]: "other" })}`, join, f.now * 1000), /^AuthenticationError: machine_grant_invalid$/);
});

test("scope tuples are not a cross-product and failed scopes never poison a valid grant nonce", async () => {
  const f = trustFixture(); f.profile.scopes.push({ subject: "other", tenantId: "other", projectId: "other", capabilities: ["chat.send"] });
  const admission = new MachineAdmission({ trustProfile: f.profile });
  for (const changes of [{ tenantId: "other" }, { projectId: "other", sub: "other" }, { sub: "other", tenantId: "other" }]) {
    await assert.rejects(admission.verify(`Bearer ${await f.token({ ...changes, jti: "same" })}`, join, f.now * 1000), /invalid/);
  }
  await admission.verify(`Bearer ${await f.token({ jti: "same" })}`, join, f.now * 1000);
});

test("profile scope and operator capability ceilings intersect without granting receive consent", async () => {
  const f = trustFixture();
  await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(
    `Bearer ${await f.token({ capabilities: ["audio.receive"] })}`, join, f.now * 1000), /invalid/);
  await assert.rejects(new MachineAdmission({ trustProfile: f.profile, allowedCapabilities: ["chat.send"] }).verify(
    `Bearer ${await f.token()}`, join, f.now * 1000), /invalid/);
  const identity = await new MachineAdmission({ trustProfile: f.profile, allowedCapabilities: ["chat.send"] }).verify(
    `Bearer ${await f.token({ capabilities: ["chat.send"] })}`, join, f.now * 1000);
  assert.deepEqual(identity.machineCapabilities, ["chat.send"]);
  assert.equal(Object.hasOwn(identity, "grants"), false);
  f.profile.scopes[0].capabilities = [];
  await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(`Bearer ${await f.token()}`, join), /disabled/);
});

test("grant replay is shared across rotation keys and concurrent verification", async () => {
  const f = trustFixture(), admission = new MachineAdmission({ trustProfile: f.profile });
  const tokens = await Promise.all([f.token({ jti: "one-use" }, 0), f.token({ jti: "one-use" }, 1)]);
  const outcomes = await Promise.allSettled(tokens.map(token => admission.verify(`Bearer ${token}`, join, f.now * 1000)));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
});

for (const name of ["missing", "unknown", "wrong-key", "jku", "jwk", "algorithm", "type", "critical"]) {
  test(`profile rejects ${name} protected header without discovery or fallback`, async () => {
    const f = trustFixture();
    const header = { alg: "EdDSA", typ: "ananta-meet-machine-v2+jwt", kid: "synthetic-0" };
    if (name === "missing") delete header.kid;
    if (name === "unknown") header.kid = "unknown";
    if (name === "wrong-key") header.kid = "synthetic-1";
    if (name === "jku") header.jku = "https://untrusted.test/key";
    if (name === "jwk") header.jwk = f.keys[0].publicKey.export({ format: "jwk" });
    if (name === "algorithm") header.alg = "none";
    if (name === "type") header.typ = "JWT";
    if (name === "critical") header.crit = ["kid"];
    const token = signedJson(JSON.stringify(header), JSON.stringify(f.payload()), f.keys[0].privateKey);
    await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(`Bearer ${token}`, join, f.now * 1000), /invalid/);
  });
}

function signedJson(header, payload, key) {
  const content = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  return `${content}.${sign(null, Buffer.from(content), key).toString("base64url")}`;
}

for (const where of ["header", "escaped-header", "payload", "escaped-payload"]) test(`reject signed duplicate ${where}`, async () => {
  const f = trustFixture(); let header = '{"alg":"EdDSA","typ":"ananta-meet-machine-v2+jwt","kid":"synthetic-0"}';
  let payload = JSON.stringify(f.payload());
  if (where === "header") header = header.replace('"alg":', '"kid":"discarded","alg":');
  if (where === "escaped-header") header = header.replace('"alg":', '"\\u006bid":"discarded","alg":');
  if (where === "payload") payload = payload.replace('{', '{"tenantId":"other",');
  if (where === "escaped-payload") payload = payload.replace('{', '{"\\u0074enantId":"other",');
  const token = signedJson(header, payload, f.keys[0].privateKey);
  await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(`Bearer ${token}`, join, f.now * 1000), /invalid/);
});

for (const name of ["before-key", "expired-key", "iat-before-key", "exp-after-key", "key-removed", "audience-removed"]) {
  test(`profile fails closed for ${name}`, async () => {
    const f = trustFixture();
    if (name === "before-key") f.profile.keys[0].notBefore = f.now + 1;
    if (name === "expired-key") f.profile.keys[0].notAfter = f.now;
    if (name === "iat-before-key") f.profile.keys[0].notBefore = f.now;
    if (name === "exp-after-key") f.profile.keys[0].notAfter = f.now + 119;
    if (name === "key-removed") f.profile.keys.shift();
    if (name === "audience-removed") f.profile.audiences = ["ananta-meet-machine-v1"];
    await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(
      `Bearer ${await f.token(name === "iat-before-key" ? { iat: f.now - 1 } : {})}`, join, f.now * 1000), /invalid/);
  });
}

test("preinstalled keys honor exact time boundaries and bounded overlap", async () => {
  const f = trustFixture();
  f.profile.keys[0].notAfter = f.now + 120;
  f.profile.keys[1].notBefore = f.now + 60;
  const admission = new MachineAdmission({ trustProfile: f.profile });
  await admission.verify(`Bearer ${await f.token()}`, join, f.now * 1000);
  await assert.rejects(admission.verify(`Bearer ${await f.token({}, 1)}`, join, (f.now + 59) * 1000), /invalid/);
  await admission.verify(`Bearer ${await f.token({ iat: f.now + 60, exp: f.now + 240 }, 1)}`, join, (f.now + 60) * 1000);
  await assert.rejects(admission.verify(`Bearer ${await f.token({ iat: f.now + 120, exp: f.now + 240 })}`,
    join, (f.now + 120) * 1000), /invalid/);
});

for (const now of [NaN, Infinity, -1, true, "1", 1.2, 8640000000000001]) test(`bad verification clock ${String(now)}`, async () => {
  const f = trustFixture();
  await assert.rejects(new MachineAdmission({ trustProfile: f.profile }).verify(`Bearer ${await f.token()}`, join, now), /invalid/);
});

test("legacy pinned-key grants remain compatible with optional kid and no profile scope expansion", async () => {
  const f = trustFixture();
  const admission = new MachineAdmission({ publicKey: f.keys[0].publicKey.export({ type: "spki", format: "pem" }), issuer: f.profile.issuer });
  const identity = await admission.verify(`Bearer ${await f.token({ tenantId: "legacy-tenant" })}`, join, f.now * 1000);
  assert.equal(identity.machineBinding.tenantId, "legacy-tenant");
});
