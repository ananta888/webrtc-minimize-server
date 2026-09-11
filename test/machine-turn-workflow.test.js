import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { parseDocument } from "yaml";

const document = parseDocument(await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const job = document.toJS().jobs["machine-turn-dialog"];
const prepare = job.steps.find(step => step.id === "prepare-turn-fixture");
const transport = value => job.steps.find(step => step.env?.MACHINE_DIALOG_ICE_PATH === value);

test("Ananta TURN TCP remains independent of UDP failure without bypassing setup or cancellation", () => {
  assert.ok(prepare);
  assert.match(prepare.run, /npm run build/);
  assert.match(prepare.run, /docker build --tag webrtc-test-tls-proxy:native-v1 test\/fixtures\/machine-tls-proxy/);
  assert.equal(job.env.MEET_TEST_PROXY_ENGINE, "native-v1");
  assert.equal(job.env.MEET_TEST_PROXY_IMAGE, "webrtc-test-tls-proxy:native-v1");
  assert.match(prepare.run, /docker pull coturn\/coturn:4\.17\.0/);
  assert.equal(prepare.if, undefined);
  assert.equal(transport("turn-udp").if, undefined);
  assert.equal(transport("turn-tcp").if,
    "${{ !cancelled() && steps.prepare-turn-fixture.outcome == 'success' }}");
  assert.ok(job.steps.indexOf(prepare) < job.steps.indexOf(transport("turn-udp")));
  assert.ok(job.steps.indexOf(transport("turn-udp")) < job.steps.indexOf(transport("turn-tcp")));
});

test("both Ananta TURN paths retain strict real-browser gates and the bounded job", () => {
  assert.equal(job["timeout-minutes"], 10);
  assert.equal(job["continue-on-error"], undefined);
  for (const step of job.steps) assert.equal(step["continue-on-error"], undefined);
  const paths = job.steps.filter(step => step.env?.MACHINE_DIALOG_ICE_PATH);
  assert.deepEqual(paths.map(step => step.env.MACHINE_DIALOG_ICE_PATH), ["turn-udp", "turn-tcp"]);
  for (const step of paths) {
    assert.equal(step.run, "node --test test/machine-dialog.browser.e2e.test.js");
  }
});
