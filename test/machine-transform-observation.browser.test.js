import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { transformFailureCounts } from "./helpers/machine-transform-observation.mjs";

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  test(`${name} executes the same redacted transform callback used by the private bridge`, { timeout: 30000 }, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.evaluate(() => {
      window.__transformErrors = ["media_envelope_version", "worker_load_or_runtime_error", "SYNTHETIC_PRIVATE_MARKER"];
    });
    const result = await page.evaluate(transformFailureCounts);
    assert.equal(result.valid, true); assert.equal(result.inspected, 3);
    assert.equal(result.counts.media_envelope_version, 1);
    assert.equal(result.counts.worker_load_or_runtime_error, 1);
    assert.equal(result.counts.unknown, 1);
    assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_MARKER"), false);
  });
}
