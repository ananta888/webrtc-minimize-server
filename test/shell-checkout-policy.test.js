import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("repository shell attributes preserve LF under a fresh autocrlf checkout", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webrtc-shell-checkout-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]);
  await fs.copyFile(new URL("../.gitattributes", import.meta.url), path.join(directory, ".gitattributes"));
  await fs.writeFile(path.join(directory, "probe.sh"), "#!/bin/sh\nset -eu\nprintf '%s\\n' shell-checkout-ok\n");
  git(["add", "--", ".gitattributes", "probe.sh"]);
  const output = path.join(directory, "checkout"); await fs.mkdir(output);
  git(["checkout-index", `--prefix=${output}/`, "--", "probe.sh"]);
  const script = path.join(output, "probe.sh");
  assert.equal((await fs.readFile(script)).includes(Buffer.from("\r\n")), false);
  assert.equal(execFileSync("sh", [script], { encoding: "utf8" }).trim(), "shell-checkout-ok");
});
