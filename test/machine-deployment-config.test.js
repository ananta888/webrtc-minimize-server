import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { machineDeploymentConfig } from "../src/machine-deployment-config.js";
import { trustFixture } from "./helpers/machine-trust.mjs";
import { assertMachineTrustMount } from "./helpers/machine-trust-mount.mjs";

const defaults = { mode: "disabled", issuer: "", publicKeyFile: "", profileFile: "", inlineKey: "", inlineProfile: "",
  capabilities: "chat.read,chat.send", authMode: "required", mediaE2eeMode: "required" };
const repository = new URL("..", import.meta.url).pathname;
const cli = path.join(repository, "scripts/machine-deployment-config.mjs");
const reloadOverride = path.join(repository, "infra/deployment/compose.machine-profile-reload.yaml");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "machine-deployment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trust = trustFixture(), profile = path.join(root, "public-profile.json"), key = path.join(root, "public-key.pem");
  fs.writeFileSync(profile, JSON.stringify(trust.profile));
  fs.writeFileSync(key, trust.keys[0].publicKey.export({ format: "pem", type: "spki" }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MACHINE_")
    && !name.startsWith("COMPOSE_") && !["AUTH_MODE", "MEDIA_E2EE_MODE"].includes(name)));
  const run = (extra = {}) => {
    const wall = Date.now(), monotonic = performance.now();
    const result = spawnSync(process.execPath, [cli], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 8000 });
    if (result.status !== 0) t.diagnostic(JSON.stringify({ stage: "deployment-config-cli", status: result.status,
      signal: ["SIGTERM", "SIGKILL"].includes(result.signal) ? result.signal : null,
      error: ["ETIMEDOUT", "ENOENT", "EACCES", "ENOBUFS"].includes(result.error?.code) ? result.error.code : null,
      wallElapsedMs: Date.now() - wall, monotonicElapsedMs: Math.round(performance.now() - monotonic) }));
    return result;
  };
  return { root, profile, key, trust, env, run };
}
test("pure selection is closed, default-off and never reads disabled trust", () => {
  assert.deepEqual(machineDeploymentConfig(defaults, () => assert.fail()), { mode: "disabled", admission: "disabled" });
  for (const extra of [{ mode: "auto" }, { mode: "" }, { other: "field" }, { inlineKey: "private" },
    { issuer: "https://hub.test" }, { profileFile: "/some/file" }, { capabilities: "unknown" }]) {
    assert.throws(() => machineDeploymentConfig({ ...defaults, ...extra }, () => assert.fail()), /machine_deployment_config_invalid/);
  }
});
test("profile and legacy modes validate exclusive public trust and explicit deny-all ceilings", t => {
  const f = fixture(t), read = file => fs.readFileSync(file, "utf8");
  for (const [mode, config] of [["profile", { profileFile: f.profile }], ["legacy", { issuer: f.trust.profile.issuer, publicKeyFile: f.key }]]) {
    assert.deepEqual(machineDeploymentConfig({ ...defaults, ...config, mode }, read), { mode, admission: "enabled" });
    assert.deepEqual(machineDeploymentConfig({ ...defaults, ...config, mode, capabilities: "" }, read), { mode, admission: "disabled" });
    for (const extra of [{ authMode: "disabled" }, { mediaE2eeMode: "preferred" }, { capabilities: "chat.read,chat.read" },
      { profileFile: f.profile, publicKeyFile: f.key }, { inlineProfile: "{}" }]) {
      assert.throws(() => machineDeploymentConfig({ ...defaults, ...config, mode, ...extra }, read), /machine_deployment_config_invalid/);
    }
  }
  for (const issuer of ["http://hub.test", "https://hub.test/path", "https://user@hub.test"]) {
    assert.throws(() => machineDeploymentConfig({ ...defaults, mode: "legacy", issuer, publicKeyFile: f.key }, read));
  }
  for (const key of [f.trust.keys[0].privateKey, generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey]) {
    const pem = key.export({ type: key.type === "private" ? "pkcs8" : "spki", format: "pem" });
    assert.throws(() => machineDeploymentConfig({ ...defaults, mode: "legacy", issuer: f.trust.profile.issuer, publicKeyFile: f.key }, () => pem));
  }
});

test("live profile deployment requires the exact public directory file and fails closed outside that mode", t => {
  const f = fixture(t), file = path.join(f.root, "machine-trust.json");
  fs.writeFileSync(file, JSON.stringify(f.trust.profile));
  const config = { ...defaults, mode: "profile-reload", profileDirectory: f.root, profileFile: file };
  assert.deepEqual(machineDeploymentConfig(config, value => fs.readFileSync(value, "utf8")), { mode: "profile-reload", admission: "enabled" });
  for (const patch of [{ mode: "disabled" }, { mode: "legacy" }, { mode: "profile" }, { profileDirectory: null },
    { profileDirectory: "" }, { profileDirectory: "relative" }, { profileFile: f.profile }]) {
    assert.throws(() => machineDeploymentConfig({ ...config, ...patch }, () => assert.fail()), /machine_deployment_config_invalid/);
  }
  const result = f.run({ MACHINE_DEPLOYMENT_MODE: "profile-reload", MACHINE_HUB_TRUST_PROFILE_DIRECTORY: f.root,
    MACHINE_HUB_TRUST_PROFILE_JSON_FILE: file });
  assert.equal(result.status, 0); assert.equal(result.stdout, "profile-reload enabled\n");
  const rendered = JSON.parse(execFileSync("docker", ["compose", "-f", path.join(repository,
    "infra/deployment/compose.machine-profile-reload.yaml"), "config", "--format", "json", "--no-consistency"],
    { env: { ...f.env, MACHINE_HUB_TRUST_PROFILE_DIRECTORY: f.root }, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
  const service = rendered.services.webrtc;
  assert.equal(service.environment.MACHINE_HUB_TRUST_RELOAD, "signal");
  assert.equal(service.environment.MACHINE_HUB_TRUST_PROFILE_JSON_FILE, "/run/machine-trust/machine-trust.json");
  const sourceVolumes = parse(fs.readFileSync(reloadOverride, "utf8")).services.webrtc.volumes;
  assert.equal(sourceVolumes.length, 1); assert.equal(service.volumes.length, 1);
  assertMachineTrustMount(sourceVolumes[0], service.volumes[0], f.root);
});
test("mount assertion accepts only explicit false or legacy omission while requiring source false", () => {
  const source = parse(fs.readFileSync(reloadOverride, "utf8")).services.webrtc.volumes[0];
  const rendered = { ...source, source: "/owned-test-directory" };
  for (const bind of [{}, { create_host_path: false }]) assertMachineTrustMount(source, { ...rendered, bind }, rendered.source);
  for (const bind of [undefined, null, [], { create_host_path: true }, { create_host_path: null },
    { create_host_path: 0 }, { create_host_path: "false" }, { propagation: "rshared" }]) {
    assert.throws(() => assertMachineTrustMount(source, { ...rendered, bind }, rendered.source));
  }
  for (const bind of [{}, undefined, { create_host_path: true }]) {
    assert.throws(() => assertMachineTrustMount({ ...source, bind }, { ...rendered, bind: {} }, rendered.source));
  }
  for (const patch of [{ read_only: false }, { source: "/wrong" }, { target: "/wrong" }, { type: "volume" }, { extra: true }]) {
    assert.throws(() => assertMachineTrustMount(source, { ...rendered, ...patch }, rendered.source));
  }
});
test("live-profile CLI rejects a missing trust directory without creating it or revealing its path", t => {
  const f = fixture(t), missing = path.join(f.root, "absent-public-trust");
  const result = f.run({ MACHINE_DEPLOYMENT_MODE: "profile-reload", MACHINE_HUB_TRUST_PROFILE_DIRECTORY: missing,
    MACHINE_HUB_TRUST_PROFILE_JSON_FILE: path.join(missing, "machine-trust.json") });
  assert.equal(result.status, 2); assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", code: "machine_deployment_config_invalid" });
  assert.equal(fs.existsSync(missing), false);
});
test("actual Compose resolves .env, interpolation, process precedence and empty ceilings without activation", t => {
  const f = fixture(t);
  const disabled = f.run();
  assert.equal(disabled.status, 0); assert.equal(disabled.stdout, "disabled disabled\n");
  fs.writeFileSync(path.join(f.root, ".env"), `MACHINE_DEPLOYMENT_MODE=profile\nPROFILE_PATH=${f.profile}\nMACHINE_HUB_TRUST_PROFILE_JSON_FILE=\${PROFILE_PATH}\n`);
  const enabled = f.run();
  assert.equal(enabled.status, 0); assert.equal(enabled.stdout, "profile enabled\n");
  const denied = f.run({ MACHINE_ALLOWED_CAPABILITIES: "" });
  assert.equal(denied.status, 0); assert.equal(denied.stdout, "profile disabled\n");
  const mixed = f.run({ MACHINE_HUB_ISSUER: f.trust.profile.issuer });
  assert.equal(mixed.status, 2); assert.equal(mixed.stdout, "");
  assert.deepEqual(JSON.parse(mixed.stderr), { status: "blocked", code: "machine_deployment_config_invalid" });
  const overridden = f.run({ MACHINE_DEPLOYMENT_MODE: "disabled", MACHINE_HUB_TRUST_PROFILE_JSON_FILE: "" });
  assert.equal(overridden.status, 0); assert.equal(overridden.stdout, "disabled disabled\n");
});
test("CLI rejects missing, private, malformed and FIFO input with only a fixed diagnostic", t => {
  const f = fixture(t);
  const fifo = path.join(f.root, "fifo"); execFileSync("mkfifo", [fifo]);
  for (const file of [fifo, path.join(f.root, "missing"), f.key]) {
    const result = f.run({ MACHINE_DEPLOYMENT_MODE: "profile", MACHINE_HUB_TRUST_PROFILE_JSON_FILE: file });
    assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /machine-deployment-\w|BEGIN PUBLIC|ENOENT/);
  }
  const result = f.run({ MACHINE_DEPLOYMENT_MODE: "legacy", MACHINE_HUB_PUBLIC_KEY: "PRIVATE_CANARY_MUST_NOT_ESCAPE" });
  assert.equal(result.status, 2); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CANARY/);
});
test("actual production Compose mounts only the selected public file on the control plane", t => {
  const f = fixture(t);
  for (const [mode, env, name, target] of [
    ["profile", { MACHINE_HUB_TRUST_PROFILE_JSON_FILE: f.profile }, "machine-hub-trust-profile", "/run/secrets/machine-hub-trust-profile"],
    ["legacy", { MACHINE_HUB_ISSUER: f.trust.profile.issuer, MACHINE_HUB_PUBLIC_KEY_FILE: f.key }, "machine-hub-public-key", "/run/secrets/machine-hub-public-key"],
  ]) {
    const files = ["compose.yaml", "infra/reverse-proxy/compose.caddy-network.yaml", "infra/deployment/compose.production.yaml",
      mode === "profile" ? "infra/deployment/compose.machine-profile.yaml" : "infra/deployment/compose.machine.yaml"];
    const rendered = JSON.parse(execFileSync("docker", ["compose", "--project-directory", f.root,
      ...files.flatMap(file => ["-f", path.join(repository, file)]), "config", "--format", "json"], {
      env: { ...f.env, ...env, MACHINE_ALLOWED_CAPABILITIES: "", WEBRTC_REVERSE_PROXY_NETWORK: "fixture-only" },
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    }));
    const service = rendered.services.webrtc;
    assert.equal(service.environment[mode === "profile" ? "MACHINE_HUB_TRUST_PROFILE_JSON_FILE" : "MACHINE_HUB_PUBLIC_KEY_FILE"], target);
    assert.equal(service.environment.MACHINE_ALLOWED_CAPABILITIES, "");
    assert.ok(service.secrets.some(secret => secret.source === name));
    assert.equal(rendered.secrets[name].file, mode === "profile" ? f.profile : f.key);
    assert.equal(service.read_only, true);
    for (const [other, config] of Object.entries(rendered.services)) if (other !== "webrtc") {
      assert.ok(!config.secrets?.some(secret => secret.source === name));
    }
  }
});
