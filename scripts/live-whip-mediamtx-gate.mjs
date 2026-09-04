import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { chromium, firefox } from "playwright";

if (process.env.RUN_LIVE_WHIP_MEDIAMTX !== "1") {
  console.log("SKIP live MediaMTX WHIP gate: set RUN_LIVE_WHIP_MEDIAMTX=1 with a pinned test endpoint");
  process.exit(0);
}

const endpoint = process.env.WHIP_MEDIAMTX_ENDPOINT || "http://127.0.0.1:18889/live-gate/whip";
const parsedEndpoint = new URL(endpoint);
assert.ok(
  parsedEndpoint.protocol === "http:"
    && new Set(["127.0.0.1", "::1", "localhost"]).has(parsedEndpoint.hostname),
  "WHIP_MEDIAMTX_ENDPOINT must be an explicit loopback HTTP test endpoint",
);

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "webrtc-whip-gate-"));
const bundlePath = path.join(temporaryDirectory, "gate.js");
let server;
try {
  await build({
    entryPoints: ["scripts/fixtures/whip-browser-live-gate.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120", "firefox120"],
    outfile: bundlePath,
    logLevel: "silent",
  });
  const bundle = await readFile(bundlePath);
  const html = Buffer.from(`<!doctype html><meta charset="utf-8"><button id="run-whip-gate">Run</button><script>window.__WHIP_GATE_ENDPOINT__=${JSON.stringify(endpoint)}</script><script src="/gate.js"></script>`);
  server = http.createServer((request, response) => {
    const content = request.url === "/gate.js" ? bundle : html;
    response.writeHead(200, {
      "content-type": request.url === "/gate.js" ? "text/javascript" : "text/html",
      "content-length": content.length,
      "cache-control": "no-store",
    });
    response.end(content);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const engine of [chromium, firefox]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
      await page.click("#run-whip-gate");
      await page.waitForFunction(() => Boolean(window.__whipGateResult), null, { timeout: 30_000 });
      const result = await page.evaluate(() => window.__whipGateResult);
      assert.deepEqual(result, {
        connected: true,
        stopped: true,
        restartError: "whip_ice_restart_unsupported",
        trackStateBeforeCleanup: "live",
      });
      console.log(`PASS live MediaMTX 1.20.1 WHIP gate (${engine.name()}): POST/PATCH/ICE/DELETE; restart visibly unsupported`);
    } finally {
      await browser.close();
    }
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
