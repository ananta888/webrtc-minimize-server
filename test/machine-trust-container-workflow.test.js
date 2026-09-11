import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("production Docker job must run the non-skippable exact-source image reload gate", () => {
  const job = parse(fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")).jobs.docker;
  const gate = job.steps.find(step => step.run === "node --test test/machine-trust-container.test.js");
  assert.ok(gate); assert.equal(gate.if, undefined); assert.equal(gate["continue-on-error"], undefined);
  assert.deepEqual(gate.env, { RUN_MACHINE_TRUST_CONTAINER_TEST: "1", MACHINE_TRUST_CONTAINER_IMAGE: "webrtc-trust-container:ci",
    MACHINE_TRUST_CONTAINER_EXPECTED_REVISION: "${{ github.sha }}",
    MACHINE_TRUST_CONTAINER_SOURCE_FIXTURE: "0" });
  const load = job.steps.find(step => step.run?.includes("--load --tag webrtc-trust-container:ci"));
  assert.ok(load); assert.equal(load.if, undefined); assert.equal(load["continue-on-error"], undefined);
  assert.match(load.run, /--build-arg SOURCE_REVISION=\$\{\{ github.sha \}\}/);
  assert.match(load.run, /--build-arg SOURCE_TIMESTAMP="\$\(git show -s --format=%cI HEAD\)"/);
  assert.ok(job.steps.indexOf(load) < job.steps.indexOf(gate));
  const dependencies = job.steps.find(step => step.run === "npm ci --ignore-scripts --no-audit --no-fund");
  assert.ok(dependencies); assert.ok(job.steps.indexOf(dependencies) < job.steps.indexOf(gate));
  assert.equal(job["continue-on-error"], undefined);
});
