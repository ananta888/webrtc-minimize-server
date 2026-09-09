import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { decodedCompanionScreen } from "./helpers/machine-avatar-coexistence.mjs";
import { collectSFramePipelines } from "./helpers/sframe-pipeline-probe.mjs";

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} private pipeline probe observes encrypted screen delivery without media content`, { timeout: 30000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine, receiverPipelineProbe: true });
    await f.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(["screen.publish"])]);
    await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    await f.machine.evaluate(async sessionId => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext("2d"); context.fillStyle = "rgb(220,20,20)"; context.fillRect(0, 0, 640, 360);
      const jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
      const source = window.anantaMachine.screen.open("screen:" + sessionId);
      for (let sequence = 1; sequence <= 8; sequence++) {
        await window.anantaMachine.screen.push(source.generation, sequence, jpeg);
        await new Promise(resolve => setTimeout(resolve, 230));
      }
    }, f.binding.sessionId);
    await f.human.waitForFunction(decodedCompanionScreen, "red", { timeout: 7000 });
    const result = await collectSFramePipelines(f.human);
    assert.equal(result.available, true); assert.equal(result.workers.length, 1);
    assert.ok(result.workers[0].rows.some(row => row.direction === "decrypt" && row.inputKey > 0 && row.enqueuedKey > 0 && !row.pipeFailed));
    assert.equal(await f.human.evaluate(() => window.__captures), 0);
    assert.equal(await f.machine.evaluate(() => window.__captures), 0);
    t.diagnostic(JSON.stringify(result));
    await f.machine.evaluate(() => window.anantaMachine.leave());
  });
}
