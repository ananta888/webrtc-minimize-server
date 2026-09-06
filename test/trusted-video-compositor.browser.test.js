import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import test from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

const soakSeconds = process.env.RUN_COMPOSITOR_SOAK === "1" ? Number(process.env.COMPOSITOR_SOAK_SECONDS || 3600) : 0;
assert.ok(Number.isSafeInteger(soakSeconds) && (soakSeconds === 0 || soakSeconds >= 10 && soakSeconds <= 21600));
for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) test(`${name} real compositor pixels, source stop, frame clock and consented overlays`, { timeout: 30_000 + soakSeconds * 1000 }, async t => {
  if (!fs.existsSync(engine.executablePath())) { t.skip(`Install Playwright ${name} for compositor pixel evidence`); return; }
  const result = await build({ entryPoints: ["scripts/fixtures/trusted-video-compositor-gate.ts"], bundle: true,
    format: "iife", platform: "browser", target: ["chrome120", "firefox120"], write: false, logLevel: "silent" });
  const bundle = result.outputFiles[0].contents;
  const bundleSha256 = crypto.createHash("sha256").update(bundle).digest("hex");
  const app = http.createServer((request, response) => {
    response.setHeader("content-type", request.url === "/gate.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/gate.js" ? bundle : '<!doctype html><button>Start synthetic compositor</button><script src="/gate.js"></script>');
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const browser = await engine.launch({ headless: true });
  t.diagnostic(JSON.stringify({ gate: "compositor-build-binding", engine: name, browserVersion: browser.version(), bundleSha256, soakSeconds }));
  t.after(async () => { await browser.close(); await new Promise(resolve => app.close(resolve)); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${app.address().port}`);
  assert.equal(await page.evaluate(() => window.__compositorGate.ready), false);
  assert.equal(await page.evaluate(() => window.__compositorGate.captureCalls), 0);
  await page.getByRole("button").click();
  await page.waitForFunction(() => window.__compositorGate.ready || window.__compositorGate.error);
  assert.equal(await page.evaluate(() => window.__compositorGate.error), "");
  const nextFrames = async () => {
    const before = await page.evaluate(() => window.__compositorGate.stats().frames);
    await page.waitForFunction(value => window.__compositorGate.stats().frames >= value + 3, before);
  };
  const layout = async (value, active = "") => { await page.evaluate(([value, active]) => window.__compositorGate.layout(value, active), [value, active]); await nextFrames(); };
  const pixels = async (points, expected) => {
    const actual = await page.evaluate(points => window.__compositorGate.pixels(points), points);
    for (let i = 0; i < actual.length; i++) assert.ok(actual[i].every((channel, c) => Math.abs(channel - expected[i][c]) < 14), `${name} pixel ${points[i]}: ${actual[i]}, expected ${expected[i]}`);
  };
  const red = [255, 0, 0], green = [0, 255, 0], blue = [0, 0, 255], background = [9, 19, 31];
  await nextFrames(); await pixels([[480, 10], [200, 100]], [red, red]); // portrait camera is cropped, not stretched
  await layout("single", "src_camerabbbbbbbbbb"); await pixels([[200, 100]], [blue]);
  await layout("single"); await pixels([[200, 100]], [red]); // clear manual choice restores the first live source
  await layout("screen-presenter"); await pixels([[40, 100], [200, 100], [800, 450]], [background, green, red]); // 4:3 screen is contained
  for (const value of ["side-by-side", "grid"]) {
    await layout(value); await pixels([[240, 135], [720, 135], [240, 405], [720, 405]], [red, green, blue, background]);
  }
  await layout("active-speaker", "src_camerabbbbbbbbbb"); await pixels([[200, 100], [840, 135], [840, 405]], [blue, red, green]);
  await layout("waiting-slate"); await pixels([[50, 50]], [background]);
  const waiting = await page.evaluate(() => window.__compositorGate.hash());
  await layout("end-slate"); assert.notEqual(await page.evaluate(() => window.__compositorGate.hash()), waiting);
  await layout("single"); const hidden = await page.evaluate(() => window.__compositorGate.hash());
  await page.evaluate(() => window.__compositorGate.overlay(true)); await nextFrames();
  const shown = await page.evaluate(() => window.__compositorGate.hash()); assert.notEqual(shown, hidden);
  await pixels([[20, 30]], [[87, 0, 0]]);
  await page.evaluate(() => window.__compositorGate.overlay(false)); await nextFrames(); await pixels([[20, 30]], [red]);
  await page.evaluate(() => window.__compositorGate.endInput(0)); await nextFrames();
  await pixels([[480, 270]], [green]);
  assert.equal(await page.evaluate(() => window.__compositorGate.stats().sourceCount), 2);
  const stats = await page.evaluate(() => window.__compositorGate.stats()); assert.equal(stats.backwards, 0); assert.ok(stats.frames >= 30);
  if (soakSeconds) {
    const start = performance.now(), deadline = start + soakSeconds * 1000;
    let previousFrames = stats.frames, samples = 0, minimumFramesPerSample = Infinity, peakHeapBytes = null, firstHeapBytes = null;
    const layouts = ["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"];
    while (performance.now() < deadline && !t.signal.aborted) {
      const selectedLayout = layouts[samples % layouts.length];
      await layout(selectedLayout);
      const beforeHash = await page.evaluate(() => window.__compositorGate.hash());
      const observationMs = Math.min(5000, Math.max(0, deadline - performance.now()));
      await new Promise(resolve => setTimeout(resolve, observationMs));
      if (!selectedLayout.endsWith("slate") && observationMs >= 1000) {
        assert.notEqual(await page.evaluate(() => window.__compositorGate.hash()), beforeHash, "known animated source pixels froze despite ongoing output");
      }
      const current = await page.evaluate(() => ({ ...window.__compositorGate.stats(), heapBytes: performance.memory?.usedJSHeapSize ?? null }));
      assert.ok(current.frames > previousFrames, "actual output frames stalled");
      assert.equal(current.backwards, 0); assert.equal(current.outputState, "live"); assert.equal(current.sourceCount, 2);
      minimumFramesPerSample = Math.min(minimumFramesPerSample, current.frames - previousFrames); previousFrames = current.frames;
      if (current.heapBytes !== null) { firstHeapBytes ??= current.heapBytes; peakHeapBytes = Math.max(peakHeapBytes ?? 0, current.heapBytes); }
      samples++;
      if (samples % 6 === 0) t.diagnostic(JSON.stringify({ gate: "compositor-soak-progress", engine: name, elapsedSeconds: Math.round((performance.now() - start) / 1000), samples, frames: previousFrames }));
    }
    assert.equal(t.signal.aborted, false);
    if (peakHeapBytes !== null) assert.ok(peakHeapBytes - firstHeapBytes < 64 * 1024 * 1024, "renderer heap grew beyond 64 MiB budget");
    t.diagnostic(JSON.stringify({ gate: "compositor-video-soak-v1", engine: name, bundleSha256, durationSeconds: (performance.now() - start) / 1000,
      samples, minimumFramesPerSample, firstHeapBytes, peakHeapBytes, audioSync: "unverified-no-audio", physicalCapture: false,
      cpu: "unmeasured", workerPath: "unverified-main-thread-only", heapEvidence: peakHeapBytes === null ? "unavailable" : "browser-estimate-not-process-RSS" }));
  } else t.diagnostic("SKIP compositor long-run evidence: set RUN_COMPOSITOR_SOAK=1 (default 3600 seconds per browser); physical A/V and CPU remain separate gates");
  assert.equal(await page.evaluate(() => window.__compositorGate.captureCalls), 0);
  const closed = await page.evaluate(() => window.__compositorGate.close()); assert.equal(closed.outputState, "ended");
  assert.deepEqual(closed.inputStates, ["ended", "ended", "ended"]);
});
