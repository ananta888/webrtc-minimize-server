import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
