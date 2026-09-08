import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { collectSFrameStartup, installSFrameStartupObservation } from "./helpers/sframe-startup-observation.mjs";

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  test(`${name} executes bounded startup diagnostics without intercepting Worker delivery`, { timeout: 15000 }, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.evaluate(installSFrameStartupObservation);
    await page.evaluate(() => {
      const label = document.createElement("div"); label.id = "sframe-status"; label.textContent = "pending";
      document.body.append(label); window.__delivered = 0;
      const source = new Blob([`postMessage({type:'transform-error',code:'media_envelope_version'});
        postMessage({type:'transform-error',code:'SYNTHETIC_PRIVATE_MARKER',contextId:'SYNTHETIC_PRIVATE_MARKER'});
        postMessage({type:'unrelated',baseKey:'SYNTHETIC_PRIVATE_MARKER'});`], { type: "text/javascript" });
      const url = URL.createObjectURL(source), worker = new Worker(url, { name: "sframe-media" });
      worker.addEventListener("message", () => {
        window.__delivered++;
        if (window.__delivered === 3) { worker.terminate(); URL.revokeObjectURL(url); }
      });
    });
    await page.waitForFunction(() => window.__delivered === 3, undefined, { timeout: 3000 });
    const observed = await collectSFrameStartup(page);
    assert.equal(observed.available, true); assert.equal(observed.state, "pending");
    assert.equal(observed.transforms.inspected, 2);
    assert.equal(observed.transforms.counts.media_envelope_version, 1);
    assert.equal(observed.transforms.counts.unknown, 1);
    assert.equal(JSON.stringify(observed).includes("SYNTHETIC_PRIVATE_MARKER"), false);
  });
}
