import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.env.RUN_LIVE_BROADCAST_LOAD_MATRIX !== "1") {
  console.log("SKIP broadcast load matrix: set RUN_LIVE_BROADCAST_LOAD_MATRIX=1 with Docker and FFmpeg 6+");
  process.exit(0);
}

const profile = JSON.parse(readFileSync(new URL("../infra/testing/broadcast-validation-profile.v1.json", import.meta.url)));
const results = [];
for (const tier of profile.originTiers) {
  const run = spawnSync(process.execPath, ["scripts/live-mediamtx-origin-load-gate.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUN_LIVE_MEDIAMTX_ORIGIN_LOAD: "1",
      MEDIAMTX_LOAD_VIEWERS: String(tier.viewers),
      MEDIAMTX_LOAD_DURATION_MS: String(tier.durationMs),
    },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${tier.id}:${run.stderr.slice(-2_000)}`);
  const line = run.stdout.trim().split(/\r?\n/).findLast((value) => value.startsWith("{"));
  assert.ok(line, `${tier.id}:missing_result`);
  const result = JSON.parse(line);
  assert.equal(result.viewerCount, tier.viewers);
  assert.equal(result.durationMs, tier.durationMs);
  assert.equal(result.errors, 0);
  assert.equal(result.completedViewers, tier.viewers);
  assert.ok(result.p95RequestLatencyMs <= profile.budgets.originP95RequestLatencyMsMax);
  results.push({ profile: tier.id, ...result });
}

console.log(JSON.stringify({ gate: "broadcast-origin-load-matrix-v1", results }));
