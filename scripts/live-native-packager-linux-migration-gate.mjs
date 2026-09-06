import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";
import { legacyLinuxRuntime } from "./testing/native-packager-legacy-linux-fixture.mjs";

if (process.env.RUN_LINUX_PACKAGER_MIGRATION !== "1") {
  console.log("SKIP real Linux migration: set RUN_LINUX_PACKAGER_MIGRATION=1 with an active user manager and unused legacy shared binary path");
  process.exit(0);
}
assert.equal(process.platform, "linux");
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "pipe", encoding: "utf8", timeout: 60_000, ...options });
const systemd = (...args) => run("systemctl", ["--user", ...args]);
systemd("show-environment");
const base = path.join(os.homedir(), ".local/share/ananta-native-packager");
if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
assert.equal(fs.lstatSync(base).isDirectory(), true); assert.equal(fs.lstatSync(base).isSymbolicLink(), false);
assert.equal(fs.statSync(base).mode & 0o777, 0o700);
const sharedBinary = path.join(base, "native-broadcast-packager");
// Exclusive creation protects existing installations, including dangling symlinks.
const source = version => `#!/bin/sh\ncase "\${1:-}" in preflight) exit 0 ;; enroll) exit 99 ;; esac\n[ '${version}' != bad-start ] || exit 42\nexec sleep 180\n`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packager-migration-systemd-"));
const artifact = path.join(directory, "native-broadcast-packager-linux-amd64");
const unitDir = path.join(os.homedir(), ".config/systemd/user");
const ids = Array.from({ length: 2 }, () => `pkr_${crypto.randomBytes(12).toString("hex")}`);
const created = [];
const environment = { ...process.env, PATH: `${directory}:${process.env.PATH}`, MIGRATION_LIVE_ARTIFACT: artifact };
const unit = id => `ananta-native-packager-${id}.service`;
const pid = id => systemd("show", "--value", "--property=MainPID", unit(id)).trim();
let cleanupFailed = false;
let sharedCreated = false;
try {
  fs.writeFileSync(sharedBinary, source("old"), { flag: "wx", mode: 0o700 });
  sharedCreated = true;
  fs.writeFileSync(path.join(directory, "curl"), `#!/bin/sh\nset -eu\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done\ncp "$MIGRATION_LIVE_ARTIFACT" "$destination"\n`, { mode: 0o700 });
  for (const id of ids) {
    const original = legacyLinuxRuntime(id);
    const unitFile = path.join(unitDir, unit(id));
    for (const file of [unitFile, path.join(base, id), path.join(base, `.migration-${id}`)]) assert.equal(fs.existsSync(file), false);
    created.push({ id, unitFile });
    fs.writeFileSync(path.join(base, `identity-${id}.pem`), `synthetic-key:${id}`, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(base, `run-${id}`), original.launcher, { flag: "wx", mode: 0o700 });
    fs.writeFileSync(path.join(base, `uninstall-${id}`), original.uninstall, { flag: "wx", mode: 0o700 });
    fs.writeFileSync(unitFile, original.unit, { flag: "wx", mode: 0o600 });
  }
  systemd("daemon-reload"); for (const id of ids) systemd("start", unit(id));
  for (const id of ids) { systemd("is-active", "--quiet", unit(id)); assert.match(pid(id), /^[1-9][0-9]*$/); }
  const secondPid = pid(ids[1]);
  const migration = (id, version) => {
    fs.writeFileSync(artifact, source(version));
    const service = new NativePackagerInstallerService({ directory });
    const generated = service.migration({ packagerId: id, targetId: "linux-amd64", publicOrigin: "https://webrtc.example" });
    const file = path.join(directory, generated.filename); fs.writeFileSync(file, generated.content, { mode: 0o600 });
    return { file, hash: crypto.createHash("sha256").update(source(version)).digest("hex") };
  };
  const first = migration(ids[0], "new");
  assert.match(run("sh", [first.file, "migrate", first.hash], { env: environment }), /Local migration complete/);
  assert.equal(pid(ids[1]), secondPid); systemd("is-active", "--quiet", unit(ids[0]));
  assert.equal(fs.readFileSync(path.join(base, ids[0], `identity-${ids[0]}.pem`), "utf8"), `synthetic-key:${ids[0]}`);
  assert.equal(fs.statSync(path.join(base, ids[0])).mode & 0o777, 0o700);
  const firstPid = pid(ids[0]);
  const failed = migration(ids[1], "bad-start");
  assert.throws(() => run("sh", [failed.file, "migrate", failed.hash], { env: environment }));
  systemd("is-active", "--quiet", unit(ids[1])); assert.equal(pid(ids[0]), firstPid);
  assert.equal(fs.readFileSync(path.join(unitDir, unit(ids[1])), "utf8"), legacyLinuxRuntime(ids[1]).unit);
  assert.equal(fs.existsSync(path.join(base, ids[1])), false);
  for (const id of ids) assert.equal(fs.readFileSync(path.join(base, `identity-${id}.pem`), "utf8"), `synthetic-key:${id}`);
  assert.match(run("sh", [first.file, "purge"], { env: environment }), /backup removed/);
  console.log("PASS real systemd shared-layout migration, private identity preservation and unchanged second process");
  console.log("PASS real systemd failed candidate rollback, restored legacy unit and explicit backup purge; no enrollment");
} finally {
  for (const { id, unitFile } of created) {
    try {
      systemd("stop", unit(id)); assert.equal(pid(id), "0");
      fs.rmSync(unitFile, { force: true });
      for (const name of [`run-${id}`, `uninstall-${id}`, `identity-${id}.pem`]) fs.rmSync(path.join(base, name), { force: true });
      for (const name of [id, `.migration-${id}`]) fs.rmSync(path.join(base, name), { recursive: true, force: true });
    } catch { cleanupFailed = true; }
  }
  systemd("daemon-reload");
  if (sharedCreated) {
    if (!cleanupFailed && !fs.lstatSync(sharedBinary).isSymbolicLink() && fs.readFileSync(sharedBinary, "utf8") === source("old")) fs.unlinkSync(sharedBinary);
    else cleanupFailed = true;
  }
  fs.rmSync(directory, { recursive: true, force: true });
  if (cleanupFailed) throw new Error("Synthetic migration cleanup incomplete; affected fixture files preserved for inspection");
}
