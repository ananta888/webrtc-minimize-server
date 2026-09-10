import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

const workflow = parseDocument(await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")).toJS();
const scripts = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).scripts;

test("CI partitions all Node files while retaining every preparation and infrastructure gate", () => {
  const shards = workflow.jobs["check-shards"];
  assert.deepEqual(shards.strategy, { "fail-fast": false, matrix: { shard: [1, 2] } });
  assert.equal(shards["timeout-minutes"], 15);
  assert.deepEqual(scripts["check:prepare"].split(" && "), ["npm run todos:validate", "npm run workflows:validate",
    "npm run deployment:validate", "npm run broadcast:release:validate", "npm run licenses:validate",
    "npm run typecheck:broadcast", "npm run test:frontend", "npm run build", "npm run security:leakage", "npm run test:go"]);
  assert.equal(scripts.check, "npm run check:prepare && npm test && npm run test:infrastructure");
  assert.equal(scripts.test, "node --test --test-concurrency=2");
  const start = shards.steps.findIndex(step => step.run === "npm run check:prepare");
  assert.ok(start >= 0);
  assert.deepEqual(shards.steps.slice(start, start + 3).map(step => step.run), ["npm run check:prepare",
    "npm test -- --test-shard=${{ matrix.shard }}/2", "npm run test:infrastructure"]);
  assert.equal(shards.steps.some(step => step["continue-on-error"]), false);
  for (const step of shards.steps.slice(start, start + 3)) assert.equal(step.if, undefined);
  const sbom = shards.steps.filter(step => step.name.includes("SBOM"));
  assert.equal(sbom.length, 2);
  assert.ok(sbom.every(step => step.if === "${{ matrix.shard == 1 }}"));
});

test("stable required CI check rejects failed, skipped and cancelled matrix results", {
  skip: process.platform === "win32" ? "Linux CI aggregation uses bash" : false,
}, () => {
  const aggregate = workflow.jobs.test;
  assert.equal(aggregate.name, "Tests and browser E2E");
  assert.deepEqual(aggregate.needs, ["check-shards"]);
  assert.equal(aggregate.if, "${{ always() }}");
  assert.equal(aggregate.steps.length, 1);
  assert.deepEqual(aggregate.steps[0].env, { CHECK_RESULT: "${{ needs.check-shards.result }}" });
  assert.equal(aggregate.steps[0].run, 'test "$CHECK_RESULT" = success');
  assert.deepEqual(workflow.jobs.docker.needs, ["test", "native-packager"]);
  // Run precisely the aggregate shell expression, with no workflow interpolation.
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const child = spawnSync("bash", ["-c", aggregate.steps[0].run], {
      env: { ...process.env, CHECK_RESULT: result }, timeout: 1000, encoding: "utf8" });
    assert.equal(child.error, undefined);
    assert.equal(child.status, result === "success" ? 0 : 1);
  }
});

test("real Node shards form a complete disjoint file set and propagate a failing member", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webrtc-check-shards-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (let i = 0; i < 6; i++) await fs.writeFile(path.join(directory, `part-${i}.test.cjs`),
    `require('node:test')('shard-fixture-${i}', () => { if (process.env.SHARD_FAIL === '${i}') throw new Error('synthetic'); });\n`);
  const members = [];
  // This child is an independent CLI invocation, not a worker of this test run.
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  for (const shard of [1, 2]) {
    const run = fail => spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-shard=${shard}/2`, "--test-reporter=tap"], {
      cwd: directory, env: { ...childEnv, SHARD_FAIL: fail ?? "none" }, timeout: 10000, maxBuffer: 16384, encoding: "utf8" });
    const passed = run();
    assert.equal(passed.error, undefined); assert.equal(passed.status, 0);
    const selected = [...passed.stdout.matchAll(/^ok \d+ - shard-fixture-(\d)$/gm)].map(match => match[1]);
    assert.equal(selected.length, 3, passed.stdout); members.push(...selected);
    const failed = run(selected[0]);
    assert.equal(failed.error, undefined); assert.equal(failed.status, 1);
    assert.match(failed.stdout, /# fail 1\b/);
  }
  assert.deepEqual(members.sort(), ["0", "1", "2", "3", "4", "5"]);
});
