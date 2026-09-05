import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("production deployment policy is default-deny, hardened and rollback-gated", () => {
  assert.match(execFileSync(process.execPath, ["scripts/validate-production-deployment.mjs"], {
    encoding: "utf8",
  }), /Validated production deployment/);
});

test("production configs contain no literal credential and expose no gateway admin port", () => {
  const combined = [
    read("infra/deployment/compose.production.yaml"),
    read("infra/deployment/production-policy.v1.json"),
    read("infra/deployment/port-firewall-matrix.v1.json"),
  ].join("\n");
  assert.doesNotMatch(combined, /(?:password|token|privateKey)\s*["':=]+\s*[A-Za-z0-9+/]{16}/i);
  const matrix = JSON.parse(read("infra/deployment/port-firewall-matrix.v1.json"));
  assert.equal(matrix.entries.filter((entry) => entry.public).every(({ component }) => (
    new Set(["caddy", "coturn", "moq"]).has(component)
  )), true);
  assert.equal(matrix.entries.find(({ component }) => component === "mediamtx-admin").public, false);
});

test("production control plane and packager have disjoint, firewall-scoped network sets", () => {
  const rendered = execFileSync("docker", [
    "compose",
    "-f", "compose.yaml",
    "-f", "infra/reverse-proxy/compose.caddy-network.yaml",
    "-f", "infra/deployment/compose.production.yaml",
    "--profile", "native-packager",
    "config", "--format", "json",
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, WEBRTC_REVERSE_PROXY_NETWORK: "policy-test-edge" },
  });
  const config = JSON.parse(rendered);
  assert.deepEqual(Object.keys(config.services.webrtc.networks).sort(), ["broadcast-origin", "control-egress", "reverse-proxy"]);
  assert.deepEqual(Object.keys(config.services["native-packager"].networks), ["packager-egress"]);
  assert.deepEqual(Object.keys(config.services["broadcast-hls-origin"].networks), ["broadcast-origin"]);
  assert.equal(config.networks["broadcast-origin"].internal, true);
  assert.equal(config.networks["reverse-proxy"].external, true);
  assert.equal(config.networks["control-egress"].ipam.config[0].subnet, "10.203.0.0/28");
  assert.equal(config.networks["packager-egress"].ipam.config[0].subnet, "10.203.0.16/28");
  assert.equal(config.services["native-packager"].environment.NATIVE_PACKAGER_ICE_TRANSPORT_POLICY, "relay");
  assert.equal(config.services["production-egress-firewall"].network_mode, "host");
  assert.deepEqual(config.services["production-egress-firewall"].cap_add, ["NET_ADMIN"]);
  assert.deepEqual(config.services["production-egress-firewall"].cap_drop, ["ALL"]);
});

test("production deploy anchors a local rollback tag before a same-revision rebuild", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "production-deploy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "docker.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "node"), `#!/bin/sh
case "$*" in
  *native-broadcast-deployment-enabled.mjs*) printf 'disabled\\n' ;;
esac
exit 0
`);
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
case "$1 $2" in
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
  "show -s") printf '2026-09-05T10:00:00Z\\n' ;;
  *) exit 2 ;;
esac
`);
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh
printf '%s|WEBRTC_IMAGE=%s\\n' "$*" "\${WEBRTC_IMAGE:-}" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ] && printf '%s' "$*" | grep -q 'ps -q webrtc'; then
  printf 'container-id\\n'
elif [ "$1" = "inspect" ]; then
  printf 'webrtc-minimize-server:old\\n'
fi
exit 0
`);
  for (const name of ["node", "git", "docker"]) chmodSync(path.join(bin, name), 0o755);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PROJECT_DIR: directory,
    FAKE_DOCKER_LOG: log,
  };
  const deploy = new URL("../scripts/production-deploy.sh", import.meta.url).pathname;

  execFileSync("sh", [deploy, "deploy"], { cwd: directory, env: environment });
  assert.equal(readFileSync(path.join(directory, ".deploy", "previous-image"), "utf8"),
    "webrtc-minimize-server:rollback\n");
  let calls = readFileSync(log, "utf8");
  assert.match(calls, /image tag webrtc-minimize-server:old webrtc-minimize-server:rollback/);
  assert.match(calls, /WEBRTC_IMAGE=webrtc-minimize-server:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);

  execFileSync("sh", [deploy, "rollback"], { cwd: directory, env: environment });
  calls = readFileSync(log, "utf8");
  assert.match(calls, /image inspect webrtc-minimize-server:rollback/);
  assert.match(calls, /WEBRTC_IMAGE=webrtc-minimize-server:rollback/);
});

test("broadcast signing-key rotation is confirmed, atomic and removes the previous key", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "production-key-rotation-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, "scripts");
  const secrets = path.join(directory, ".deploy", "secrets");
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "docker.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  mkdirSync(bin);
  const ensure = new URL("../scripts/ensure-broadcast-signing-key.mjs", import.meta.url).pathname;
  copyFileSync(ensure, path.join(scripts, "ensure-broadcast-signing-key.mjs"));
  const key = path.join(secrets, "broadcast-signing-private-key.pem");
  execFileSync(process.execPath, [ensure, key]);
  const previous = readFileSync(key, "utf8");

  writeFileSync(path.join(bin, "node"), `#!/bin/sh
case "$*" in
  *ensure-broadcast-signing-key.mjs*) exec ${process.execPath} "$@" ;;
  *native-broadcast-deployment-enabled.mjs*) printf 'disabled\\n'; exit 0 ;;
  *production-smoke-gate.mjs*) exit 0 ;;
esac
exit 2
`);
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh
printf '%s|WEBRTC_IMAGE=%s\\n' "$*" "\${WEBRTC_IMAGE:-}" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ] && printf '%s' "$*" | grep -q 'ps -q webrtc'; then
  printf 'container-id\\n'
elif [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then
  printf 'webrtc-minimize-server:current\\n'
fi
exit 0
`);
  for (const name of ["node", "docker"]) chmodSync(path.join(bin, name), 0o755);
  const deploy = new URL("../scripts/production-deploy.sh", import.meta.url).pathname;
  assert.throws(() => execFileSync("sh", [deploy, "rotate-broadcast-key"], {
    cwd: directory,
    stdio: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECT_DIR: directory, FAKE_DOCKER_LOG: log },
  }));
  try {
    execFileSync("sh", [deploy, "rotate-broadcast-key"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECT_DIR: directory,
        FAKE_DOCKER_LOG: log, CONFIRM_BROADCAST_KEY_ROTATION: "1",
      },
    });
  } catch (error) {
    assert.fail(`rotation failed: ${error.stderr || ""} ${error.stdout || ""} ${error.message}`);
  }
  assert.notEqual(readFileSync(key, "utf8"), previous);
  assert.equal(readFileSync(log, "utf8").includes("--force-recreate --wait webrtc"), true);
  assert.equal(readFileSync(path.join(directory, ".deploy", "secrets", "broadcast-signing-private-key.pem"), "utf8")
    .includes("BEGIN PRIVATE KEY"), true);
  assert.equal(readFileSync(key, "utf8").length < 16 * 1024, true);
  assert.equal(readFileSync(log, "utf8").includes("WEBRTC_IMAGE=webrtc-minimize-server:current"), true);
  assert.equal(readFileSync(key, "utf8").includes("PRIVATE KEY"), true);
  assert.equal(readFileSync(key, "utf8").includes(previous), false);
  assert.equal(readFileSync(key, "utf8").trim().length > 0, true);
  assert.throws(() => readFileSync(`${key}.previous`, "utf8"), /ENOENT/);
  assert.throws(() => readFileSync(`${key}.next`, "utf8"), /ENOENT/);
});
