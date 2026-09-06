import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("real Docker build context excludes synthetic credentials and nested runtime state", { timeout: 60_000 }, t => {
  const root = mkdtempSync(path.join(tmpdir(), "webrtc-context-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = path.join(root, "context"), output = path.join(root, "output");
  mkdirSync(context);
  copyFileSync(new URL("../.dockerignore", import.meta.url), path.join(context, ".dockerignore"));
  const denied = [".deploy/secrets/signing.pem", ".deploy/previous-images", "data/owner.db", ".env", ".env.production",
    "credentials.pem", "identity.key", "credentials.p12", "credentials.pfx", ".git/config", "node_modules/pkg/index.js"];
  const allowed = ["src/server.js", "frontend/app.ts", "contracts/test.json", ".env.example", "native-broadcast-packager/main.go"];
  for (const prefix of ["", "nested/"]) for (const filename of [...denied, ...allowed]) {
    const target = path.join(context, prefix, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, denied.includes(filename) ? "SYNTHETIC_CONTEXT_CANARY_NOT_A_SECRET" : "public-source-fixture");
  }
  writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  execFileSync("docker", ["buildx", "build", "--no-cache", "--network=none", "--progress=plain",
    "--output", `type=local,dest=${output}`, context], { stdio: "pipe", timeout: 45_000 });
  const files = readdirSync(output, { recursive: true }).map(String);
  for (const prefix of ["", "nested/"]) {
    for (const filename of denied) assert.equal(files.includes(prefix + filename), false, `credential reached builder output: ${prefix + filename}`);
    for (const filename of allowed) assert.equal(files.includes(prefix + filename), true, `source excluded: ${prefix + filename}`);
  }
});
