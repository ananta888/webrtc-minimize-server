import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parseDocument } from "yaml";
import { trustFixture } from "./helpers/machine-trust.mjs";

const repository = new URL("..", import.meta.url).pathname;
const override = path.join(repository, "infra/deployment/compose.machine-profile-reload.yaml");
const production = parseDocument(fs.readFileSync(path.join(repository, "infra/deployment/compose.production.yaml"), "utf8"),
  { customTags: [{ tag: "!reset", collection: "seq", resolve: value => value },
    { tag: "!override", collection: "map", resolve: value => value }] }).toJS().services.webrtc;
const sandbox = { init: true, read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], pids_limit: 256 };

test("isolated trust gate uses the production init and process-hardening settings", () => {
  for (const [name, value] of Object.entries(sandbox)) assert.deepEqual(production[name], value);
});

// Source-mounted mode is a quick Linux runtime check, NOT a production-image gate.
// CI must supply the actual built image and must not set the source fixture flag.
test("container init forwards trust reload, preserves process identity and denies missing/writable host mounts", {
  timeout: 90_000,
  skip: process.env.RUN_MACHINE_TRUST_CONTAINER_TEST !== "1"
    ? "Set RUN_MACHINE_TRUST_CONTAINER_TEST=1 and MACHINE_TRUST_CONTAINER_IMAGE for isolated Docker evidence" : false,
}, async t => {
  const fixtureMode = process.env.MACHINE_TRUST_CONTAINER_SOURCE_FIXTURE === "1";
  const selected = process.env.MACHINE_TRUST_CONTAINER_IMAGE;
  assert.ok(typeof selected === "string" && selected.length > 0 && selected.length <= 256 && !selected.startsWith("-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COMPOSE_") && !key.startsWith("MACHINE_")));
  function docker(args, allowFailure = false) {
    const result = spawnSync("docker", args, { env, encoding: "utf8", timeout: 8000, maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"] });
    // Never dump raw Docker/config/profile diagnostics, including on failure.
    assert.equal(Boolean(result.error), false, "trust_gate_docker_execution_failed");
    if (!allowFailure) assert.equal(result.status, 0, "trust_gate_docker_command_failed");
    return result;
  }
  const image = JSON.parse(docker(["image", "inspect", selected]).stdout)[0];
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
  if (!fixtureMode) {
    assert.match(process.env.MACHINE_TRUST_CONTAINER_EXPECTED_REVISION ?? "", /^[0-9a-f]{40}$/);
    assert.equal(image.Config.Labels?.["org.opencontainers.image.revision"], process.env.MACHINE_TRUST_CONTAINER_EXPECTED_REVISION);
    assert.equal(image.Config.Labels?.["io.ananta.meet.trust-reload"], "sighup-v1");
    assert.deepEqual(image.Config.Cmd, ["node", "src/server.js"]);
    assert.equal(image.Config.User, "node");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meet-trust-container-"));
  const directory = path.join(root, "public-trust"), file = path.join(directory, "machine-trust.json");
  const project = "meet-trust-" + path.basename(root).slice("meet-trust-container-".length).toLowerCase();
  const composeFile = path.join(root, "compose.json"), f = trustFixture();
  let container;
  const service = { ...sandbox, image: image.Id, pull_policy: "never", network_mode: "none", restart: "no",
    environment: { HOST: "127.0.0.1", PORT: "8080", AUTH_MODE: "required", MEDIA_E2EE_MODE: "required",
      PAIR_WORKSPACE_DB: ":memory:", MEDIA_AGENT_REGISTRATION_DB: ":memory:", NATIVE_PACKAGER_REGISTRATION_DB: ":memory:",
      OIDC_ISSUER: f.profile.issuer, OIDC_AUDIENCE: "synthetic-human", OIDC_CLIENT_ID: "synthetic-browser" } };
  if (fixtureMode) {
    service.user = "node"; service.working_dir = "/app"; service.command = ["node", "src/server.js"];
    service.volumes = ["src", "contracts", "node_modules", "package.json"].map(name => ({ type: "bind",
      source: path.join(repository, name), target: "/app/" + name, read_only: true, bind: { create_host_path: false } }));
  }
  fs.writeFileSync(composeFile, JSON.stringify({ services: { webrtc: service } }));
  const compose = (args, allowFailure = false) => {
    env.MACHINE_HUB_TRUST_PROFILE_DIRECTORY = directory;
    return docker(["compose", "--project-directory", root, "-p", project, "-f", composeFile, "-f", override, ...args], allowFailure);
  };
  t.after(() => {
    // The unique project contains only this fixture; never production resources.
    try { compose(["down", "--timeout", "1"]); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const missing = compose(["up", "-d", "--no-build", "--pull", "never"], true);
  assert.notEqual(missing.status, 0, "missing_mount_must_fail");
  assert.match(missing.stderr, /bind source path does not exist/, "failure_must_be_missing_mount_not_an_unrelated_error");
  assert.equal(fs.existsSync(directory), false, "compose_must_not_create_trust_directory");
  fs.mkdirSync(directory, { mode: 0o755 });
  const replace = profile => {
    fs.writeFileSync(file + ".next", typeof profile === "string" ? profile : JSON.stringify(profile), { mode: 0o644 });
    fs.renameSync(file + ".next", file);
  };
  replace(f.profile);
  compose(["up", "-d", "--no-build", "--pull", "never"]);
  container = compose(["ps", "-q", "webrtc"]).stdout.trim();
  assert.match(container, /^[0-9a-f]{64}$/);
  const inspect = () => JSON.parse(docker(["inspect", container]).stdout)[0];
  const original = inspect();
  assert.equal(original.HostConfig.Init, true); assert.equal(original.HostConfig.NetworkMode, "none");
  assert.equal(original.HostConfig.ReadonlyRootfs, true);
  const mount = original.Mounts.filter(m => m.Destination === "/run/machine-trust");
  assert.equal(mount.length, 1); assert.equal(mount[0].RW, false); assert.equal(mount[0].Source, directory);
  const status = () => docker(["exec", container, "node", "--input-type=module", "-e",
    `const r=await fetch('http://127.0.0.1:8080/api/machine/capabilities',{signal:AbortSignal.timeout(1000)});
     if(!r.ok)process.exit(2); const body=await r.json(); console.log(JSON.stringify({admissionEnabled:body.admissionEnabled}));`], true);
  let ready;
  for (let attempt = 0; attempt < 12; attempt++) {
    ready = status(); if (ready.status === 0) break; await delay(100);
  }
  if (ready.status !== 0) {
    const failed = inspect(), logs = docker(["logs", container], true);
    const knownErrors = ["ENOENT", "EACCES", "ERR_MODULE_NOT_FOUND", "machine_trust_file_invalid",
      "machine_trust_reload_config_invalid", "machine_trust_profile_invalid"];
    t.diagnostic(JSON.stringify({ stage: "startup", running: failed.State.Running, exitCode: failed.State.ExitCode,
      errors: knownErrors.filter(code => (logs.stdout + logs.stderr).includes(code)),
      missingPublicTrustFile: (logs.stdout + logs.stderr).includes("/run/machine-trust/machine-trust.json"),
      missingDataDirectory: (logs.stdout + logs.stderr).includes("/app/data"),
      missingTmpDirectory: (logs.stdout + logs.stderr).includes("/tmp/") }));
  }
  assert.equal(ready.status, 0, "container_startup_failed");
  assert.deepEqual(JSON.parse(ready.stdout), { admissionEnabled: true });
  const write = docker(["exec", "--user", "0", container, "node", "--input-type=module", "-e",
    `import fs from 'node:fs'; try { fs.writeFileSync('/run/machine-trust/forbidden','x'); process.exit(2); }
     catch(error) { if(error.code!=='EROFS')process.exit(3); console.log('readonly'); }`]);
  assert.equal(write.stdout.trim(), "readonly"); assert.equal(fs.existsSync(path.join(directory, "forbidden")), false);
  let acknowledgements = 0;
  async function signal(expected, admissionEnabled) {
    compose(["kill", "--signal", "SIGHUP", "webrtc"]);
    let events;
    for (let attempt = 0; attempt < 12; attempt++) {
      const logs = docker(["logs", container]);
      assert.doesNotMatch(logs.stdout + logs.stderr, /private-invalid-canary|synthetic-0|BEGIN|machine-trust\.json/);
      events = logs.stdout.split("\n").filter(line => line.startsWith('{"schema":"ananta.meet-trust-reload.v1"')).map(line => JSON.parse(line));
      if (events.length > acknowledgements) break;
      await delay(100);
    }
    assert.equal(events.length, ++acknowledgements, "exactly_one_reload_ack_required");
    assert.deepEqual(events.at(-1), { schema: "ananta.meet-trust-reload.v1", status: expected });
    const current = inspect();
    assert.equal(current.Id, original.Id); assert.equal(current.State.Pid, original.State.Pid);
    assert.equal(current.State.StartedAt, original.State.StartedAt); assert.equal(current.RestartCount, 0);
    const actual = status(); assert.equal(actual.status, 0);
    assert.deepEqual(JSON.parse(actual.stdout), { admissionEnabled });
  }
  await signal("unchanged", true);
  replace({ ...f.profile, revision: 2, scopes: [] }); await signal("updated", false);
  replace("private-invalid-canary"); await signal("blocked", false);
  replace(f.profile); await signal("blocked", false);
  replace({ ...f.profile, revision: 3 }); await signal("updated", true);
  t.diagnostic(JSON.stringify({ scope: fixtureMode ? "source-mounted-runtime" : "production-image-runtime",
    missingHostPathDenied: true, readOnly: true, initSignalForwarded: true, atomicRenameObserved: true,
    invalidAndRollbackDenied: true, higherRevisionRecovered: true, processPreserved: true }));
});
