import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { machineRolloutPreflight, parseMachineRolloutPlan } from "../src/machine-rollout-preflight.js";
import { trustFixture } from "./helpers/machine-trust.mjs";

function fixture() {
  const f = trustFixture();
  const plan = { schema: "ananta.meet-rollout-plan.v2", meetRevision: "a".repeat(40), hubRevision: "b".repeat(40),
    publicOrigin: "https://meet.example.test", hubIssuer: f.profile.issuer, tenantId: "tenant", projectId: "project",
    roomId: "room-0123456789abcdef01", capabilities: ["chat.read", "chat.send"], trustRevision: 1,
    keyId: "synthetic-0", subject: "ananta", audience: "ananta-meet-machine-v2", grantTtlSeconds: 120,
    hubKeySha256: createHash("sha256").update(f.keys[0].publicKey.export({ type: "spki", format: "der" })).digest("hex") };
  const config = { machineHubTrustProfile: f.profile, publicOrigin: plan.publicOrigin, authMode: "required",
    mediaE2eeMode: "required", machineAllowedCapabilities: ["chat.read", "chat.send"] };
  return { plan, config, revision: plan.meetRevision, clean: true, now: f.now * 1000 };
}

test("profile preflight verifies exact local expectations without production approval or data disclosure", () => {
  const f = fixture(), result = machineRolloutPreflight(f);
  assert.equal(result.localReady, true); assert.equal(result.productionReady, false);
  assert.equal(result.checks.filter(check => check.status === "unverified").length, 5);
  assert.equal(result.checks.filter(check => check.status === "fail").length, 0);
  for (const value of [f.plan.roomId, f.plan.hubIssuer, f.plan.keyId, f.plan.hubKeySha256,
    f.config.machineHubTrustProfile.keys[0].x]) assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal(Object.isFrozen(parseMachineRolloutPlan(f.plan).capabilities), true);
});

const changes = {
  revision: f => { f.plan.trustRevision++; }, keyId: f => { f.plan.keyId = "other"; },
  subject: f => { f.plan.subject = "other"; }, tenant: f => { f.plan.tenantId = "other"; },
  project: f => { f.plan.projectId = "other"; }, publicPin: f => { f.plan.hubKeySha256 = "c".repeat(64); },
  issuer: f => { f.plan.hubIssuer = "https://other.example.test"; },
  audience: f => { f.config.machineHubTrustProfile.audiences = ["ananta-meet-machine-v1"]; },
  scopeCaps: f => { f.config.machineHubTrustProfile.scopes[0].capabilities = ["chat.send"]; },
  globalCaps: f => { f.config.machineAllowedCapabilities = ["chat.send"]; },
  missingProfile: f => { delete f.config.machineHubTrustProfile; }, malformedProfile: f => { f.config.machineHubTrustProfile = {}; },
  legacyKey: f => { f.config.machineHubPublicKey = "second-trust-source"; },
  legacyIssuer: f => { f.config.machineHubIssuer = f.plan.hubIssuer; },
  futureKey: f => { f.config.machineHubTrustProfile.keys[0].notBefore = f.now / 1000 + 1; },
  expiredKey: f => { f.config.machineHubTrustProfile.keys[0].notAfter = f.now / 1000; },
  shortKey: f => { f.config.machineHubTrustProfile.keys[0].notAfter = f.now / 1000 + 119; },
  undefinedClock: f => { f.now = NaN; }, fractionalClock: f => { f.now += 0.5; },
  negativeClock: f => { f.now = -1; }, infiniteClock: f => { f.now = Infinity; }, booleanClock: f => { f.now = true; },
};
for (const [name, mutate] of Object.entries(changes)) test(`preflight denies ${name}`, () => {
  const f = fixture(); mutate(f); const result = machineRolloutPreflight(f);
  assert.equal(result.localReady, false); assert.equal(result.productionReady, false);
});

test("v1 and v2 trust modes do not fall back and legacy audience has its exact fixed capabilities", () => {
  const f = fixture();
  const v1 = { ...f.plan, schema: "ananta.meet-rollout-plan.v1" };
  for (const key of ["trustRevision", "keyId", "subject", "audience", "grantTtlSeconds"]) delete v1[key];
  assert.equal(machineRolloutPreflight({ ...f, plan: v1 }).localReady, false);
  f.plan.audience = "ananta-meet-machine-v1";
  assert.equal(machineRolloutPreflight(f).localReady, false);
  f.plan.capabilities = f.config.machineAllowedCapabilities = ["avatar.publish", "chat.send", "speech.publish"];
  assert.equal(machineRolloutPreflight(f).localReady, true);
});

test("current key window includes exact expiry and millisecond boundaries without extending TTL", () => {
  const f = fixture(); f.config.machineHubTrustProfile.keys[0].notBefore = f.now / 1000;
  f.config.machineHubTrustProfile.keys[0].notAfter = f.now / 1000 + 120;
  assert.equal(machineRolloutPreflight(f).localReady, true);
  assert.equal(machineRolloutPreflight({ ...f, now: f.now - 1 }).localReady, false);
  assert.equal(machineRolloutPreflight({ ...f, now: f.now + 999 }).localReady, true);
  assert.equal(machineRolloutPreflight({ ...f, now: f.now + 1000 }).localReady, false);
});

for (const changes of [{ trustRevision: true }, { trustRevision: 0 }, { keyId: "../key" }, { keyId: "" },
  { subject: "*" }, { audience: "human" }, { grantTtlSeconds: 0 }, { grantTtlSeconds: 601 },
  { grantTtlSeconds: 1.1 }, { grantTtlSeconds: true }, { extra: "private-marker" }]) {
  test(`closed v2 plan rejects ${Object.keys(changes)[0]} ${JSON.stringify(changes)}`, () => {
    assert.throws(() => parseMachineRolloutPlan({ ...fixture().plan, ...changes }), /machine_rollout_plan_invalid/);
  });
}

test("real CLI checks clean, modified and untracked source snapshots without disclosing scope", { timeout: 12000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-trust-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(), path = join(directory, "plan.json"), profilePath = join(directory, "public-trust.json");
  const cwd = join(directory, "checkout"), emptyConfig = join(directory, "empty-git-config");
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  writeFileSync(emptyConfig, "");
  // Exact current source, not HEAD: exercise uncommitted implementation too.
  // No shared index, inherited hooks/config or moving developer checkout state.
  cpSync(new URL("../src", import.meta.url), join(cwd, "src"), { recursive: true });
  copyFileSync(new URL("../package.json", import.meta.url), join(cwd, "package.json"));
  copyFileSync(new URL("../scripts/machine-rollout-preflight.mjs", import.meta.url),
    join(cwd, "scripts/machine-rollout-preflight.mjs"));
  // Deliberately clean environment: no operator secrets or inherited trust.
  const env = { PATH: process.env.PATH, AUTH_MODE: "required", OIDC_ISSUER: "https://synthetic-human.test",
    OIDC_AUDIENCE: "human", PUBLIC_ORIGIN: f.plan.publicOrigin, STUN_URLS: "",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig,
    MACHINE_HUB_TRUST_PROFILE_JSON_FILE: profilePath, MACHINE_ALLOWED_CAPABILITIES: "chat.read,chat.send" };
  const git = args => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 2000 }).trim();
  git(["init", "--quiet", "--template="]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "--", "src", "scripts/machine-rollout-preflight.mjs", "package.json"]);
  git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  f.plan.meetRevision = git(["rev-parse", "HEAD"]);
  writeFileSync(path, JSON.stringify(f.plan)); writeFileSync(profilePath, JSON.stringify(f.config.machineHubTrustProfile));
  const run = file => spawnSync(process.execPath, ["scripts/machine-rollout-preflight.mjs", file],
    { cwd, env, encoding: "utf8", timeout: 5000, maxBuffer: 32768 });
  const verify = clean => {
    assert.equal(git(["status", "--porcelain", "--untracked-files=normal"]) === "", clean);
    const response = run(path);
    assert.equal(response.error, undefined); assert.equal(response.stderr, "");
    const result = JSON.parse(response.stdout); assert.equal(result.productionReady, false);
    const failed = result.checks.filter(check => check.status === "fail").map(check => check.code);
    assert.deepEqual(failed, clean ? [] : ["meet_worktree_clean"]);
    assert.equal(result.checks.find(check => check.code === "machine_trust_scope_allowed").status, "pass");
    assert.equal(result.checks.find(check => check.code === "machine_trust_key_selected").status, "pass");
    assert.equal(result.localReady, clean); assert.equal(response.status, clean ? 0 : 2);
    for (const value of [directory, f.plan.roomId, f.plan.keyId, f.config.machineHubTrustProfile.keys[0].x]) {
      assert.equal(response.stdout.includes(value), false);
    }
  };
  verify(true);
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
  verify(false);
  copyFileSync(new URL("../package.json", import.meta.url), join(cwd, "package.json"));
  verify(true);
  const untracked = join(cwd, "untracked-fixture");
  writeFileSync(untracked, "synthetic\n");
  verify(false);
  rmSync(untracked);
  verify(true);
  writeFileSync(path, JSON.stringify(f.plan).replace('"subject":', '"subject":"foreign","subject":'));
  const duplicate = run(path); assert.equal(duplicate.status, 2); assert.equal(duplicate.stderr, "");
  assert.equal(JSON.parse(duplicate.stdout).code, "machine_preflight_input_or_config_invalid");
  const fifo = join(directory, "fifo"); execFileSync("mkfifo", [fifo], { timeout: 1000 });
  const bounded = run(fifo);
  assert.equal(bounded.error, undefined); assert.equal(bounded.status, 2); assert.equal(bounded.stderr, "");
  assert.equal(JSON.parse(bounded.stdout).code, "machine_preflight_input_or_config_invalid");
});
