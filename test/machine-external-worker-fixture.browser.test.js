import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

test("external Worker fixture owns only the actual receiving context without an unused machine page", { timeout: 30000 }, async t => {
  const stages = [];
  const f = await machineBrowserFixture(t, { externalMachine: true, observeStage: stage => stages.push(stage) });
  assert.equal(f.machine, null);
  assert.equal(f.browser.contexts().length, 1);
  assert.equal(f.app.registry.members(f.roomId).length, 1);
  assert.equal(await f.human.evaluate(() => window.__captures), 0);
  assert.equal(stages.includes("machine-navigation"), false);
  await assert.rejects(f.additionalMachine(), /test_machine_fixture_capacity/);
});

for (const externalMachine of [null, 1, "true", {}]) {
  test("invalid external Worker selection fails before resources are allocated", async () => {
    let cleanup = 0;
    await assert.rejects(machineBrowserFixture({ after: () => cleanup++ }, { externalMachine }), /test_external_machine_invalid/);
    assert.equal(cleanup, 0);
  });
}
