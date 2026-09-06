import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

test("machine v1 publishes generated speech, avatar and chat to a human under required SFrame", {
  timeout: 80_000, skip: !process.env.MACHINE_E2E_VIDEO && "Set MACHINE_E2E_VIDEO to a synthetic local GPU demo MP4",
}, async context => {
  const video = await fs.readFile(process.env.MACHINE_E2E_VIDEO);
  assert.ok(video.length > 100 && video.length < 3_500_000);
  const f = await machineBrowserFixture(context);
  await f.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant([], 1)]);
  await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
  // A v1 machine is publish-only, never a synthetic shortcut around receive consent.
  await Promise.all([
    f.machine.evaluate(encoded => window.anantaMachine.publish("Synthetischer GPU-Test", encoded), video.toString("base64")),
    f.human.waitForFunction(async () => {
      let frames = 0, samples = 0;
      for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) {
        if (stat.type === "inbound-rtp") { frames += stat.framesDecoded || 0; samples += stat.totalSamplesReceived || 0; }
      }
      return frames > 3 && samples > 1000;
    }, null, { timeout: 60_000 }),
  ]);
  await f.human.getByRole("button", { name: "Chat", exact: true }).click();
  await f.human.locator("#chat-log").getByText("Synthetischer GPU-Test", { exact: false }).waitFor();
  assert.equal(await f.machine.evaluate(() => window.__captures), 0);
  assert.equal(await f.human.evaluate(() => window.__captures), 0);
  await f.machine.evaluate(() => window.anantaMachine.leave());
  assert.equal(await f.machine.evaluate(() => window.anantaMachine.status().joined), false);
  assert.deepEqual(await f.machine.evaluate(() => window.anantaMachine.status().chat), []);
});
