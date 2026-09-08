import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const deploy = new URL("../scripts/production-deploy.sh", import.meta.url).pathname;
const revision = "a".repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-set-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const script = (name, content) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${content}\n`, { mode: 0o700 });
  script("git", `case "$1" in status) ;; rev-parse) echo ${revision} ;; show) echo 2026-09-06T00:00:00Z ;; *) exit 2 ;; esac`);
  script("sleep", "exit 0");
  script("node", `case "$*" in
    *machine-deployment-config.mjs*) echo "\${IMAGE_SET_TEST_MACHINE:-disabled disabled}" ;;
    *native-broadcast-deployment-enabled.mjs*) echo enabled ;;
    *production-smoke-gate.mjs*)
      echo smoke >> "$IMAGE_SET_TEST_ROOT/log"
      if [ "\${IMAGE_SET_TEST_FAIL:-}" = smoke ] && [ -f "$IMAGE_SET_TEST_ROOT/web-active" ] && grep -q '${revision}' "$IMAGE_SET_TEST_ROOT/web-active"; then exit 1; fi ;;
    *ensure-broadcast-signing-key.mjs*) ;;
    *) exit 2 ;;
  esac`);
  script("docker", `echo "$*|web=\${WEBRTC_IMAGE:-}|native=\${NATIVE_PACKAGER_IMAGE:-}|origin=\${BROADCAST_HLS_ORIGIN_IMAGE:-}" >> "$IMAGE_SET_TEST_ROOT/log"
case "$*" in
  *'ps -q '*)
    [ "\${IMAGE_SET_TEST_EMPTY:-0}" != 1 ] || exit 0
    case "$*" in *'ps -q webrtc') echo web-container ;; *'ps -q native-packager') echo native-container ;; *'ps -q broadcast-hls-origin') echo origin-container ;; esac ;;
  'inspect --format '* )
    case "$3" in
      '{{.Config.Image}}') echo fixture:available; exit 0 ;;
      '{{.ImageManifestDescriptor.Platform.OS}}/{{.ImageManifestDescriptor.Platform.Architecture}}') echo linux/amd64; exit 0 ;;
      '{{.ImageManifestDescriptor.Digest}}') echo sha256:${"b".repeat(64)}; exit 0 ;;
    esac
    case "$*" in *web-container) echo sha256:web ;; *native-container) echo sha256:native ;; *origin-container) echo sha256:origin ;; esac ;;
  'image inspect --platform '*)
    if [ "\${IMAGE_SET_TEST_FAIL:-}" = manifest-mismatch ]; then echo sha256:${"c".repeat(64)}; else echo sha256:${"b".repeat(64)}; fi ;;
  'image inspect --format '*) echo sha256:available-index ;;
  'image inspect '*)
    [ "\${IMAGE_SET_TEST_FAIL:-}" != missing-image ]
    case "\${IMAGE_SET_TEST_FAIL:-}" in missing-index|manifest-mismatch) case "$*" in *sha256:origin) exit 1 ;; esac ;; esac ;;
  'image tag '*) [ "\${IMAGE_SET_TEST_FAIL:-}" != snapshot-tag ] ;;
  'build '*) [ "\${IMAGE_SET_TEST_FAIL:-}" != web-build ] ;;
  *' build native-packager broadcast-hls-origin') [ "\${IMAGE_SET_TEST_FAIL:-}" != native-build ] ;;
  *' run --rm --no-deps --pull never native-packager preflight') [ "\${IMAGE_SET_TEST_FAIL:-}" != preflight ] ;;
  *' up '*'native-packager broadcast-hls-origin')
    case "\${NATIVE_PACKAGER_IMAGE:-}" in
      *:rollback.*) [ "\${IMAGE_SET_TEST_FAIL:-}" != rollback-native ] ;;
      *) [ "\${IMAGE_SET_TEST_FAIL:-}" != native-up ] ;;
    esac
    echo "$NATIVE_PACKAGER_IMAGE" > "$IMAGE_SET_TEST_ROOT/native-active"
    echo "$BROADCAST_HLS_ORIGIN_IMAGE" > "$IMAGE_SET_TEST_ROOT/origin-active" ;;
  *' up '*' webrtc')
    case "\${WEBRTC_IMAGE:-}" in *:rollback.*) ;; *) [ "\${IMAGE_SET_TEST_FAIL:-}" != web-up ] ;; esac
    echo "$WEBRTC_IMAGE" > "$IMAGE_SET_TEST_ROOT/web-active" ;;
esac`);
  const run = (action = "deploy", extra = {}) => execFileSync("sh", [deploy, action], { cwd: root, timeout: 10_000,
    encoding: "utf8", stdio: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECT_DIR: root,
      IMAGE_SET_TEST_ROOT: root, ...extra } });
  const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
  return { root, run, read };
}

test("complete image-set update builds and preflights before switching, then restores all three versions", t => {
  const { root, run, read } = fixture(t);
  run();
  const snapshot = read(".deploy/previous-images").trim().split("\n");
  assert.equal(snapshot[0], "image-set-v1"); assert.equal(snapshot.length, 4);
  for (const tag of snapshot.slice(1)) assert.match(tag, /:rollback\.[A-Za-z0-9]{6}$/);
  const log = read("log");
  assert.ok(log.indexOf("image tag sha256:web") < log.indexOf("build native-packager"));
  assert.ok(log.indexOf("native-packager preflight") < log.indexOf("up -d --no-build --pull never --wait native-packager"));
  assert.ok(log.indexOf("build --pull") < log.indexOf("up -d --no-build --pull never --wait native-packager"));
  fs.writeFileSync(path.join(root, "log"), "");
  run("rollback");
  assert.equal(read("web-active").trim(), snapshot[1]);
  assert.equal(read("native-active").trim(), snapshot[2]);
  assert.equal(read("origin-active").trim(), snapshot[3]);
  assert.doesNotMatch(read("log"), /(?:^|\n)build --pull|volume rm|down |enroll|\bprune\b/);
  assert.ok(!fs.existsSync(path.join(root,".deploy/operation.lock")));
});

for (const mode of ["legacy", "profile"]) test(`${mode} trust selection stays present through deployment and rollback`, t => {
  const { root, run, read } = fixture(t);
  const directory = path.join(root, "infra/deployment"); fs.mkdirSync(directory, { recursive: true });
  const file = mode === "profile" ? "compose.machine-profile.yaml" : "compose.machine.yaml";
  fs.copyFileSync(new URL(`../infra/deployment/${file}`, import.meta.url), path.join(directory, file));
  const extra = { IMAGE_SET_TEST_MACHINE: `${mode} enabled` };
  run("deploy", extra); run("rollback", extra);
  const calls = read("log").split("\n").filter(line => line.startsWith("compose "));
  assert.ok(calls.length > 5); for (const call of calls) assert.ok(call.includes(file));
});

test("missing selected override fails before creating deployment state", t => {
  const { root, run } = fixture(t);
  assert.throws(() => run("deploy", { IMAGE_SET_TEST_MACHINE: "profile enabled" }));
  assert.equal(fs.existsSync(path.join(root, ".deploy")), false);
  assert.equal(fs.existsSync(path.join(root, "log")), false);
});

test("invalid deployment selection fails before locks, snapshots and any Docker mutation", t => {
  const { root, run } = fixture(t);
  assert.throws(() => run("deploy", { IMAGE_SET_TEST_MACHINE: "invalid private-output" }));
  assert.equal(fs.existsSync(path.join(root, ".deploy")), false);
  assert.equal(fs.existsSync(path.join(root, "log")), false);
});

for (const failure of ["native-build", "preflight", "web-build", "native-up", "web-up", "smoke"]) {
  test(`image-set ${failure} failure preserves or restores the entire baseline`, t => {
    const { root, run, read } = fixture(t);
    assert.throws(() => run("deploy", { IMAGE_SET_TEST_FAIL: failure }));
    const log = read("log");
    if (["native-build", "preflight", "web-build"].includes(failure)) {
      assert.doesNotMatch(log, /up -d --no-build --pull never --wait (native-packager|webrtc)/);
    } else {
      const snapshot = read(".deploy/previous-images").trim().split("\n");
      assert.equal(read("native-active").trim(), snapshot[2]);
      assert.equal(read("origin-active").trim(), snapshot[3]);
      assert.equal(read("web-active").trim(), snapshot[1]);
    }
    assert.ok(!fs.existsSync(path.join(root,".deploy/operation.lock")));
  });
}

test("rollback validates the whole snapshot before mutations and refuses a legacy native rollback", t => {
  const { root, run, read } = fixture(t);
  run();
  const snapshot = read(".deploy/previous-images");
  for (const content of [snapshot + "extra\n", snapshot.replace("image-set-v1", "v2"), snapshot.replace("broadcast-hls-origin:rollback.", "broadcast-hls-origin:latest.")]) {
    fs.writeFileSync(path.join(root,".deploy/previous-images"), content);
    fs.writeFileSync(path.join(root,"log"), "");
    assert.throws(() => run("rollback"));
    assert.doesNotMatch(read("log"), / up | stop /);
  }
  fs.unlinkSync(path.join(root,".deploy/previous-images"));
  fs.writeFileSync(path.join(root,".deploy/previous-image"), "webrtc-minimize-server:rollback\n");
  assert.throws(() => run("rollback"), /Legacy rollback/);
});

test("deployment lock prevents concurrent updates and snapshots never reuse older tags", t => {
  const { root, run, read } = fixture(t);
  run(); const first = read(".deploy/previous-images");
  fs.mkdirSync(path.join(root,".deploy/operation.lock"));
  assert.throws(() => run(), /already active/);
  assert.equal(read(".deploy/previous-images"), first);
  fs.rmdirSync(path.join(root,".deploy/operation.lock"));
  run(); assert.notEqual(read(".deploy/previous-images"), first);
});

test("failed snapshot leaves the previous complete manifest and missing images prevent rollback mutations", t => {
  const { root, run, read } = fixture(t);
  run(); const snapshot = read(".deploy/previous-images");
  assert.throws(() => run("deploy", { IMAGE_SET_TEST_FAIL: "snapshot-tag" }));
  assert.equal(read(".deploy/previous-images"), snapshot);
  fs.writeFileSync(path.join(root,"log"), "");
  assert.throws(() => run("rollback", { IMAGE_SET_TEST_FAIL: "missing-image" }));
  assert.doesNotMatch(read("log"), / up | stop /);
});

test("missing multi-platform index is recovered only for identical running platform content", t => {
  const { root, run, read } = fixture(t);
  run("deploy", { IMAGE_SET_TEST_FAIL: "missing-index" });
  assert.match(read("log"), /image tag sha256:available-index webrtc-minimize-server-broadcast-hls-origin:rollback\./);
  const snapshot = read(".deploy/previous-images");
  fs.writeFileSync(path.join(root,"log"), "");
  assert.throws(() => run("deploy", { IMAGE_SET_TEST_FAIL: "manifest-mismatch" }), /differs from available/);
  assert.equal(read(".deploy/previous-images"), snapshot);
  assert.doesNotMatch(read("log"), / up | build /);
});

test("a failed native rollback remains an error and does not claim a healthy restored web app", t => {
  const { root, run, read } = fixture(t);
  run(); fs.writeFileSync(path.join(root,"log"), "");
  assert.throws(() => run("rollback", { IMAGE_SET_TEST_FAIL: "rollback-native" }));
  assert.doesNotMatch(read("log"), /--wait webrtc|smoke/);
});

test("failed first installation stops only the new services and never deletes volumes", t => {
  const { run, read } = fixture(t);
  assert.throws(() => run("deploy", { IMAGE_SET_TEST_EMPTY: "1", IMAGE_SET_TEST_FAIL: "web-up" }));
  assert.equal(read(".deploy/previous-images"), "image-set-v1\n-\n-\n-\n");
  assert.match(read("log"), /stop broadcast-hls-origin native-packager/);
  assert.match(read("log"), /stop webrtc/);
  assert.doesNotMatch(read("log"), /volume rm|down |\bprune\b/);
});
