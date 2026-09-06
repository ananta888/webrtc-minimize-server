import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";
import { artifactFilename, buildNativePackagerRelease, readNativePackagerRelease, RELEASE_FILENAME, RELEASE_TARGETS, validateNativePackagerRelease } from "../src/native-packager-release.js";

const build = { revision: "a".repeat(40), builtAt: "2026-09-06T10:00:00Z", agentVersion: "0.7.0", goVersion: "go1.24.13" };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packager-release-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const target of RELEASE_TARGETS) fs.writeFileSync(path.join(directory, artifactFilename(target)), `synthetic:${target}`);
  const bytes = buildNativePackagerRelease(directory, build);
  fs.writeFileSync(path.join(directory, RELEASE_FILENAME), bytes);
  const service = new NativePackagerInstallerService({ directory });
  return { directory, bytes, service, value: JSON.parse(bytes) };
}
test("release is deterministic, closed and matches every artifact without changing signed bytes", t => {
  const f = fixture(t);
  assert.deepEqual(buildNativePackagerRelease(f.directory, build), f.bytes);
  assert.deepEqual(f.service.release().body, f.bytes);
  assert.equal(f.service.release().manifest.artifacts.length, 5);
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(fs.readFileSync("contracts/native-packager/release.v1.schema.json", "utf8")));
  assert.equal(validate(f.value), true, JSON.stringify(validate.errors));
  for (const mutate of [value => { value.version = 2; }, value => { value.authority = true; }, value => { value.repository = "other/repo"; },
    value => { value.artifacts[0].filename = "../secret"; }, value => { value.artifacts[0].target = "windows-arm64"; },
    value => { value.artifacts[0].bytes = 134217729; }, value => { value.artifacts[0].sha256 = "xyz"; },
    value => { value.artifacts[0].token = "forbidden"; }, value => { value.artifacts.reverse(); }, value => { value.revision = "unknown"; }]) {
    const invalid = structuredClone(f.value); mutate(invalid);
    assert.equal(validate(invalid), false); assert.throws(() => validateNativePackagerRelease(invalid), /invalid/);
  }
  const badDate = structuredClone(f.value); badDate.builtAt = "2026-02-30T10:00:00Z";
  assert.throws(() => validateNativePackagerRelease(badDate), /invalid/);
});
test("mismatched artifact, missing metadata, symlink, malformed and oversize fail closed", t => {
  const f = fixture(t), filename = path.join(f.directory, RELEASE_FILENAME);
  const read = () => readNativePackagerRelease(f.directory, id => f.service.artifact(id));
  const changed = structuredClone(f.value); changed.artifacts[0].sha256 = "0".repeat(64);
  for (const body of [JSON.stringify(changed), "{", " ".repeat(32769)]) {
    fs.writeFileSync(filename, body); assert.throws(read); assert.throws(() => f.service.release(), /release_unavailable/);
  }
  fs.unlinkSync(filename); assert.throws(read);
  fs.writeFileSync(path.join(f.directory, "saved"), f.bytes); fs.symlinkSync(path.join(f.directory, "saved"), filename);
  assert.throws(read);
});
test("generator requires versioned build information and never overwrites an existing manifest", t => {
  const f = fixture(t), buildFile = path.join(f.directory, "build.json");
  fs.writeFileSync(buildFile, JSON.stringify(build));
  const run = (...args) => execFileSync(process.execPath, ["scripts/build-native-packager-release.mjs", f.directory, buildFile, ...args], { stdio: "pipe" });
  assert.throws(() => run(), /EEXIST/);
  fs.unlinkSync(path.join(f.directory, RELEASE_FILENAME));
  fs.writeFileSync(buildFile, JSON.stringify({ ...build, revision: "unknown" }));
  assert.throws(() => run(), /invalid/);
  assert.match(run("--allow-unversioned").toString(), /SKIP/);
  assert.equal(fs.existsSync(path.join(f.directory, RELEASE_FILENAME)), false);
  fs.writeFileSync(buildFile, JSON.stringify(build)); run();
  assert.deepEqual(fs.readFileSync(path.join(f.directory, RELEASE_FILENAME)), f.bytes);
});
