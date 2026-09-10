import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { trustFixture } from "./helpers/machine-trust.mjs";

test("real local SIGHUP reloads atomic profile replacements without restarting the server", { timeout: 8000,
  skip: process.platform === "win32" ? "POSIX signal fixture; Windows requires operator restart" : false }, async t => {
  const f = trustFixture(), directory = mkdtempSync(join(tmpdir(), "machine-trust-signal-")), file = join(directory, "machine-trust.json");
  writeFileSync(file, JSON.stringify(f.profile));
  const env = { HOST: "127.0.0.1", PORT: "0", AUTH_MODE: "required", MEDIA_E2EE_MODE: "required",
    OIDC_ISSUER: f.profile.issuer, OIDC_AUDIENCE: "synthetic-human", OIDC_CLIENT_ID: "synthetic-browser",
    MACHINE_HUB_TRUST_PROFILE_JSON_FILE: file, MACHINE_HUB_TRUST_RELOAD: "signal" };
  const code = `import {startServer} from ${JSON.stringify(new URL("../src/server.js", import.meta.url).href)};
    await startServer({env: ${JSON.stringify(env)}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout }), queued = [];
  let waiting;
  lines.on("line", line => { if (waiting) { const deliver = waiting; waiting = null; deliver(line); } else if (queued.length < 8) queued.push(line); });
  const next = () => new Promise((resolve, reject) => {
    if (queued.length) return resolve(queued.shift());
    const timer = setTimeout(() => { waiting = null; reject(new Error("test_trust_reload_ack_timeout")); }, 2000);
    waiting = line => { clearTimeout(timer); resolve(line); };
  });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const started = await next(), port = /:(\d+)$/.exec(started)?.[1]; assert.ok(port);
  const endpoint = `http://127.0.0.1:${port}`;
  async function signal(expected) {
    const ack = next(); assert.equal(child.kill("SIGHUP"), true);
    assert.deepEqual(JSON.parse(await ack), { schema: "ananta.meet-trust-reload.v1", status: expected });
    assert.equal((await fetch(endpoint + "/healthz", { signal: AbortSignal.timeout(1000) })).status, 200);
  }
  await signal("unchanged");
  writeFileSync(file + ".next", JSON.stringify({ ...f.profile, revision: 2, scopes: [] })); renameSync(file + ".next", file);
  await signal("updated");
  assert.equal((await (await fetch(endpoint + "/api/machine/capabilities")).json()).admissionEnabled, false);
  writeFileSync(file, "private-invalid-canary"); await signal("blocked");
  writeFileSync(file + ".next", JSON.stringify({ ...f.profile, revision: 3 })); renameSync(file + ".next", file);
  await signal("updated");
  assert.equal((await (await fetch(endpoint + "/api/machine/capabilities")).json()).admissionEnabled, true);
});
