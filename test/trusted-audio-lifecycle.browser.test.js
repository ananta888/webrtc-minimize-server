import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) test(`${name} real AudioContext cancellation, source stop and injected resume stall`, { timeout: 45_000 }, async t => {
  if (!fs.existsSync(engine.executablePath())) { t.skip(`Install Playwright ${name} for real AudioContext evidence`); return; }
  const result = await build({ entryPoints: ["scripts/fixtures/trusted-audio-lifecycle-gate.ts"], bundle: true,
    format: "iife", platform: "browser", target: ["chrome120", "firefox120"], write: false, logLevel: "silent" });
  const app = http.createServer((request, response) => {
    response.setHeader("content-type", request.url === "/gate.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/gate.js" ? result.outputFiles[0].contents : '<!doctype html><button>Start synthetic audio</button><script src="/gate.js"></script>');
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const browser = await engine.launch({ headless: true, timeout: 10_000 });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${app.address().port}`);
  assert.deepEqual(await page.evaluate(() => window.__audioLifecycleGate), { ready: false, error: "", phase: "idle", captureCalls: 0, results: [] });
  await page.getByRole("button").click();
  try {
    await page.waitForFunction(() => window.__audioLifecycleGate.ready || window.__audioLifecycleGate.error, null, { timeout: 20_000 });
  } catch {
    assert.fail(`${name} audio fixture did not finish: ${JSON.stringify(await page.evaluate(() => window.__audioLifecycleGate))}`);
  }
  const resultData = await page.evaluate(() => window.__audioLifecycleGate);
  assert.equal(resultData.error, ""); assert.equal(resultData.captureCalls, 0);
  assert.deepEqual(resultData.results, ["abort", "source-stop", "injected-pending-resume"].map(scenario => ({
    scenario, peakObserved: scenario !== "injected-pending-resume", contextState: "closed", outputState: "ended",
    inputState: scenario === "source-stop" ? "ended" : "live", sourceContextState: "running",
  })));
});
