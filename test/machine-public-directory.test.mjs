import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { machinePublicDirectory } from "./helpers/machine-public-directory.mjs";

test("private build directory is explicit, validated and never created or rewritten", async t => {
  assert.equal(await machinePublicDirectory(undefined), undefined);
  for (const value of [null, "", "relative", 3, "/" + "x".repeat(4096)]) {
    await assert.rejects(machinePublicDirectory(value), /test_public_directory_invalid/);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meet-build-unit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(machinePublicDirectory(directory), /test_public_directory_unavailable/);
  assert.deepEqual(await fs.readdir(directory), []);
  const index = path.join(directory, "index.html");
  await fs.mkdir(index);
  await assert.rejects(machinePublicDirectory(directory), /test_public_directory_unavailable/);
  await fs.rmdir(index);
  await fs.writeFile(index, "synthetic-index");
  assert.equal(await machinePublicDirectory(directory), await fs.realpath(directory));
  assert.equal(await fs.readFile(index, "utf8"), "synthetic-index");
});
