import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { machineRolloutPreflight, parseMachineRolloutPlan } from "../src/machine-rollout-preflight.js";

function fixture() {
  const key = generateKeyPairSync("ed25519").publicKey;
  const plan = { schema: "ananta.meet-rollout-plan.v1", meetRevision: "a".repeat(40), hubRevision: "b".repeat(40),
    publicOrigin: "https://meet.example.test", hubIssuer: "https://hub.example.test", tenantId: "private-tenant",
    projectId: "private-project", roomId: "room-aaaaaaaaaaaaaaaaaa", capabilities: ["chat.read", "chat.send"],
    hubKeySha256: createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") };
  return { plan, revision: plan.meetRevision, clean: true, config: { publicOrigin: plan.publicOrigin, authMode: "required",
    mediaE2eeMode: "required", machineHubIssuer: plan.hubIssuer, machineHubPublicKey: key.export({ type: "spki", format: "pem" }),
    machineAllowedCapabilities: ["chat.read", "chat.send"] } };
}
test("local readiness never attests external Hub policy, source consent or production", () => {
  const f = fixture(), result = machineRolloutPreflight(f);
  assert.equal(result.localReady, true); assert.equal(result.productionReady, false);
  assert.equal(result.checks.filter(c => c.status === "unverified").length, 5);
  const output = JSON.stringify(result);
  for (const value of [f.plan.roomId, f.plan.tenantId, f.plan.projectId, f.config.machineHubPublicKey, f.plan.hubIssuer]) {
    assert.ok(!output.includes(value), "diagnostics exclude scope and key material");
  }
});
test("preflight denies changed revision, dirty source, insecure transport, wrong pin and capability expansion", () => {
  for (const changes of [{ publicOrigin: "http://meet.example.test" }, { authMode: "disabled" }, { mediaE2eeMode: "preferred" },
    { machineHubIssuer: "https://other.example.test" }, { machineHubPublicKey: "bad key" }, { machineAllowedCapabilities: [] }]) {
    const f = fixture(); Object.assign(f.config, changes); assert.equal(machineRolloutPreflight(f).localReady, false);
  }
  assert.equal(machineRolloutPreflight({ ...fixture(), clean: false }).localReady, false);
  assert.equal(machineRolloutPreflight({ ...fixture(), revision: "c".repeat(40) }).localReady, false);
});
test("plans are closed and cannot launder credentials, arbitrary room names or unsupported permissions", () => {
  const f = fixture();
  for (const changes of [{ extra: true }, { schema: "next" }, { capabilities: ["tools"] }, { capabilities: [] },
    { capabilities: ["chat.read", "chat.read"] }, { publicOrigin: "https://user:password@meet.example.test" },
    { hubIssuer: "https://hub.example.test?token=secret" }, { roomId: "../other" }, { meetRevision: "main" }]) {
    assert.throws(() => parseMachineRolloutPlan({ ...f.plan, ...changes }));
  }
});
test("CLI error is bounded JSON without echoing secret-looking input or paths", () => {
  try { execFileSync(process.execPath, ["scripts/machine-rollout-preflight.mjs", "/not-present/private-token-sentinel"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); assert.fail("must fail closed"); }
  catch (error) {
    assert.equal(error.status, 2); assert.equal(error.stderr, "");
    assert.ok(!error.stdout.includes("private-token-sentinel"));
    assert.equal(JSON.parse(error.stdout).productionReady, false);
  }
});
