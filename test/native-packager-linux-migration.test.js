import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";
import { legacyLinuxRuntime as legacy } from "../scripts/testing/native-packager-legacy-linux-fixture.mjs";

const id = "pkr_0123456789abcdef", other = "pkr_fedcba9876543210";
const binary = version => `#!/bin/sh\ncase "\${1:-}" in enroll) exit 99 ;; preflight) [ '${version}' != bad-preflight ]; exit $? ;; health) [ '${version}' != bad-start ]; exit $? ;; esac\n# version=${version}\n`;
function fixture(t, version = "new") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packager-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtureHome = path.join(directory, "user space"), base = path.join(fixtureHome, ".local/share/ananta-native-packager");
  const unitDir = path.join(fixtureHome, ".config/systemd/user"), commands = path.join(directory, "commands"), states = path.join(directory, "states");
  for (const item of [base, unitDir, commands, states]) fs.mkdirSync(item, { recursive: true, mode: 0o700 });
  const root = path.join(base, id), journal = path.join(base, `.migration-${id}`);
  const unit = `ananta-native-packager-${id}.service`, unitFile = path.join(unitDir, unit);
  for (const agent of [id, other]) {
    const original = legacy(agent);
    fs.writeFileSync(path.join(base, `identity-${agent}.pem`), `synthetic-key:${agent}`, { mode: 0o600 });
    fs.writeFileSync(path.join(base, `run-${agent}`), original.launcher, { mode: 0o700 });
    fs.writeFileSync(path.join(base, `uninstall-${agent}`), original.uninstall, { mode: 0o700 });
    fs.writeFileSync(path.join(unitDir, `ananta-native-packager-${agent}.service`), original.unit, { mode: 0o600 });
    fs.writeFileSync(path.join(states, `ananta-native-packager-${agent}.service`), "500");
  }
  fs.writeFileSync(path.join(base, "native-broadcast-packager"), binary("old"), { mode: 0o700 });
  const artifact = path.join(directory, "native-broadcast-packager-linux-amd64"); fs.writeFileSync(artifact, binary(version));
  const service = new NativePackagerInstallerService({ directory });
  const migration = service.migration({ packagerId: id, targetId: "linux-amd64", publicOrigin: "https://webrtc.example" });
  const script = path.join(directory, migration.filename); fs.writeFileSync(script, migration.content);
  const command = (name, source) => fs.writeFileSync(path.join(commands, name), `#!/bin/sh\nset -eu\n${source}\n`, { mode: 0o700 });
  command("sleep", "exit 0"); command("timeout", 'shift; exec "$@"');
  command("curl", `while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done\ncp "$MIG_ARTIFACT" "$destination"`);
  command("systemctl", `printf '%s\\n' "$*" >> "$MIG_CALLS"
for arg in "$@"; do unit=$arg; done
state="$MIG_STATES/$unit"
case "$*" in
 *--property=FragmentPath*) printf '%s\\n' "$HOME/.config/systemd/user/$unit" ;;
 *--property=DropInPaths*) printf '%s' "\${MIG_DROPIN:-}" ;;
 *--property=MainPID*) cat "$state" ;;
 *'is-active '*) [ "$(cat "$state")" != 0 ] ;;
 *'stop '*)
   [ "\${MIG_STOP_FAIL:-0}" != 1 ] || exit 1
   if [ "\${MIG_KILL_PHASE:-}" = stop ]; then kill -KILL "$MIG_PROCESS"; exit 0; fi
   printf '%s' 0 > "$state" ;;
 *'start '*)
   if [ "\${MIG_KILL_PHASE:-}" = start ]; then kill -KILL "$MIG_PROCESS"; exit 0; fi
   target="$HOME/.local/share/ananta-native-packager/native-broadcast-packager"
   if grep -q '/${id}/run-' "$HOME/.config/systemd/user/$unit"; then target="$HOME/.local/share/ananta-native-packager/${id}/native-broadcast-packager"; fi
   "$target" health || exit 1
   printf '%s' 600 > "$state" ;;
 *daemon-reload*) ;;
 *) exit 2 ;;
esac`);
  command("rm", `if [ "\${MIG_KILL_PHASE:-}" = committed ] && [ "$*" = "-f -- $MIG_ROOT/.migration-pending" ]; then kill -KILL "$MIG_PROCESS"; exit 0; fi
if [ "\${MIG_KILL_PHASE:-}" = cleanup ] && [ "\${3:-}" = "$MIG_JOURNAL/discard/native-broadcast-packager" ]; then /bin/rm -f -- "$3"; kill -KILL "$MIG_PROCESS"; exit 0; fi
if [ "\${MIG_KILL_PHASE:-}" = purge ] && [ "\${3:-}" = "$MIG_JOURNAL/unit" ]; then /bin/rm -f -- "$3"; kill -KILL "$MIG_PROCESS"; exit 0; fi
exec /bin/rm "$@"`);
  const env = { ...process.env, HOME: fixtureHome, PATH: `${commands}:${process.env.PATH}`, MIG_ROOT: root, MIG_JOURNAL: journal, MIG_ARTIFACT: artifact, MIG_STATES: states, MIG_CALLS: path.join(directory, "calls") };
  const run = (args, extra = {}) => execFileSync("sh", ["-c", 'MIG_PROCESS=$$; export MIG_PROCESS; exec sh "$@"', "sh", script, ...args], { env: { ...env, ...extra }, stdio: "pipe", encoding: "utf8", timeout: 10_000 });
  const hash = crypto.createHash("sha256").update(binary(version)).digest("hex");
  const unchanged = () => {
    assert.equal(fs.readFileSync(path.join(base, `identity-${id}.pem`), "utf8"), `synthetic-key:${id}`);
    assert.equal(fs.readFileSync(path.join(base, `identity-${other}.pem`), "utf8"), `synthetic-key:${other}`);
    assert.equal(fs.readFileSync(path.join(base, `run-${other}`), "utf8"), legacy(other).launcher);
    assert.equal(fs.readFileSync(path.join(base, `uninstall-${other}`), "utf8"), legacy(other).uninstall);
    assert.equal(fs.readFileSync(path.join(unitDir, `ananta-native-packager-${other}.service`), "utf8"), legacy(other).unit);
    assert.equal(fs.readFileSync(path.join(states, `ananta-native-packager-${other}.service`), "utf8"), "500");
    assert.equal(fs.readFileSync(path.join(base, "native-broadcast-packager"), "utf8"), binary("old"));
  };
  return { directory, base, root, journal, unitFile, unit, env, run, hash, unchanged, artifact, script };
}
test("Linux shared-layout migration preserves identity and second agent, guards old entry points and explicitly purges backup", t => {
  const f = fixture(t);
  assert.match(f.run(["migrate", f.hash]), /Local migration complete/);
  assert.equal(fs.readFileSync(path.join(f.root, `identity-${id}.pem`), "utf8"), `synthetic-key:${id}`);
  assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.root, `identity-${id}.pem`)).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(f.unitFile, "utf8"), new RegExp(`ReadWritePaths="%h/.local/share/ananta-native-packager/${id}"`));
  assert.equal(fs.existsSync(path.join(f.root, ".migration-pending")), false);
  assert.throws(() => execFileSync("sh", [path.join(f.base, `uninstall-${id}`)], { env: f.env, stdio: "pipe" }), /legacy entry was migrated/);
  f.unchanged(); assert.match(f.run(["purge"]), /backup removed/); assert.equal(fs.existsSync(f.journal), false); f.unchanged();
  assert.doesNotMatch(fs.readFileSync(f.script, "utf8"), /unused-migration-render-only|\"\$binary\" enroll/);
});
for (const scenario of ["bad-hash", "bad-preflight", "bad-start", "stop-fail"]) test(`Linux migration ${scenario} fails closed without changing the second agent`, t => {
  const f = fixture(t, scenario.startsWith("bad-") && scenario !== "bad-hash" ? scenario : "new");
  if (scenario === "bad-hash") fs.writeFileSync(f.artifact, "tampered download");
  assert.throws(() => f.run(["migrate", f.hash], scenario === "stop-fail" ? { MIG_STOP_FAIL: "1" } : {}));
  if (scenario === "stop-fail") assert.match(f.run(["recover"]), /Original user service restored/);
  assert.equal(fs.readFileSync(f.unitFile, "utf8"), legacy(id).unit);
  assert.equal(fs.existsSync(f.root), false); f.unchanged();
});
for (const phase of ["stop", "start", "committed"]) test(`Linux migration actual SIGKILL at ${phase} recovers from its bounded journal`, t => {
  const f = fixture(t);
  assert.throws(() => f.run(["migrate", f.hash], { MIG_KILL_PHASE: phase }), error => error.signal === "SIGKILL");
  assert.equal(fs.existsSync(f.journal), true);
  assert.throws(() => execFileSync("sh", [path.join(f.root, `update-${id}`), "update", f.hash], { env: f.env, stdio: "pipe" }), /Migration recovery/);
  assert.throws(() => execFileSync("sh", [path.join(f.root, `uninstall-${id}`)], { env: f.env, stdio: "pipe" }), /Migration-Wiederherstellung/);
  assert.match(f.run(["recover"]), phase === "committed" ? /completion recovered/ : /Original user service restored/);
  assert.equal(fs.existsSync(f.root), phase === "committed"); f.unchanged();
});
test("Linux migration rejects customized units, symlinked identities and conflicting destinations before stopping", t => {
  const f = fixture(t);
  assert.throws(() => f.run(["migrate", f.hash], { MIG_DROPIN: "override.conf" }), /Custom or non-legacy unit/);
  fs.appendFileSync(f.unitFile, "# custom\n"); assert.throws(() => f.run(["migrate", f.hash]), /Custom or non-legacy unit/);
  fs.writeFileSync(f.unitFile, legacy(id).unit);
  const key = path.join(f.base, `identity-${id}.pem`); fs.renameSync(key, `${key}.saved`); fs.symlinkSync(`${key}.saved`, key);
  assert.throws(() => f.run(["migrate", f.hash]), /Unsafe legacy file/); fs.unlinkSync(key); fs.renameSync(`${key}.saved`, key);
  fs.mkdirSync(f.root); assert.throws(() => f.run(["migrate", f.hash]), /Destination/);
  assert.doesNotMatch(fs.readFileSync(f.env.MIG_CALLS, "utf8"), /--user stop/); f.unchanged();
});
test("real migration flock excludes another operation and unknown backup files prevent purge without deletion", async t => {
  const f = fixture(t);
  const holder = spawn("flock", ["-x", path.join(f.base, ".migration.lock"), "sh", "-c", "echo ready; read answer"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => holder.kill()); await once(holder.stdout, "data");
  assert.throws(() => f.run(["migrate", f.hash]), /Another legacy migration/);
  const ended = once(holder, "exit"); holder.stdin.end("done\n"); await ended;
  f.run(["migrate", f.hash]); fs.writeFileSync(path.join(f.journal, "unknown-user-file"), "retain");
  assert.throws(() => f.run(["purge"]), /Unexpected backup files/);
  assert.equal(fs.readFileSync(path.join(f.journal, "identity"), "utf8"), `synthetic-key:${id}`); f.unchanged();
});

for (const target of ["legacy-key", "shared-binary", "new-launcher"]) test(`Linux migration recovery rejects a substituted ${target} symlink before stopping`, t => {
  const f = fixture(t);
  assert.throws(() => f.run(["migrate", f.hash], { MIG_KILL_PHASE: "start" }), error => error.signal === "SIGKILL");
  const file = target === "legacy-key" ? path.join(f.base, `identity-${id}.pem`)
    : target === "shared-binary" ? path.join(f.base, "native-broadcast-packager") : path.join(f.root, `run-${id}`);
  fs.renameSync(file, `${file}.saved`); fs.symlinkSync(`${file}.saved`, file);
  const calls = fs.readFileSync(f.env.MIG_CALLS, "utf8");
  assert.throws(() => f.run(["recover"]), /Recovery incomplete/);
  assert.doesNotMatch(fs.readFileSync(f.env.MIG_CALLS, "utf8").slice(calls.length), /--user stop/);
  assert.equal(fs.existsSync(path.join(f.journal, "identity")), true);
  fs.unlinkSync(file); fs.renameSync(`${file}.saved`, file);
  assert.match(f.run(["recover"]), /Original user service restored/); f.unchanged();
});

for (const phase of ["cleanup", "purge"]) test(`Linux migration resumes interrupted ${phase} after partial deletion without losing identity`, t => {
  const f = fixture(t, phase === "cleanup" ? "bad-start" : "new");
  if (phase === "purge") f.run(["migrate", f.hash]);
  assert.throws(() => f.run(phase === "cleanup" ? ["migrate", f.hash] : ["purge"], { MIG_KILL_PHASE: phase }), error => error.signal === "SIGKILL");
  assert.equal(fs.existsSync(path.join(f.journal, phase === "cleanup" ? "discard/native-broadcast-packager" : "unit")), false);
  assert.match(f.run([phase === "cleanup" ? "recover" : "purge"]), phase === "cleanup" ? /interrupted cleanup completed/ : /backup removed/);
  assert.equal(fs.existsSync(f.journal), false); f.unchanged();
});

test("committed migration recovery preserves its fence when the candidate binary changed", t => {
  const f = fixture(t);
  assert.throws(() => f.run(["migrate", f.hash], { MIG_KILL_PHASE: "committed" }), error => error.signal === "SIGKILL");
  const file = path.join(f.root, "native-broadcast-packager"), original = fs.readFileSync(file);
  fs.appendFileSync(file, "# altered\n");
  assert.throws(() => f.run(["recover"]), /Committed migration requires inspection/);
  assert.equal(fs.existsSync(path.join(f.root, ".migration-pending")), true);
  fs.writeFileSync(file, original); assert.match(f.run(["recover"]), /completion recovered/); f.unchanged();
});
