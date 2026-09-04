import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium, firefox } from "playwright";

import { createAppServer } from "../src/server.js";

test("Chromium and Firefox expose Vosk sources, local sharing and the fixed catalog without implicit capture", { timeout: 45_000 }, async (context) => {
  const engines = [];
  for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) {
    try {
      await fs.access(engine.executablePath());
      engines.push({ name, engine });
    } catch {
      // Each missing browser is reported explicitly below; one installed engine still provides useful coverage.
    }
  }
  if (engines.length === 0) {
    context.skip("Playwright Chromium and Firefox are not installed");
    return;
  }

  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      authMode: "disabled",
      stunUrls: [],
      turnServers: [],
      turnUrls: [],
      edgeTurnServers: [],
      mediaAgents: [],
      pairWorkspaceEnabled: false,
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  context.after(async () => {
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });

  for (const { name, engine } of engines) {
    const browser = await engine.launch({ headless: true });
    try {
      const browserContext = await browser.newContext();
      await browserContext.addInitScript(() => {
        window.__captionCaptureCalls = [];
        if (!navigator.mediaDevices) return;
        for (const method of ["getUserMedia", "getDisplayMedia"]) {
          if (typeof navigator.mediaDevices[method] !== "function") continue;
          const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
          navigator.mediaDevices[method] = (...args) => {
            window.__captionCaptureCalls.push(method);
            return original(...args);
          };
        }
      });
      let modelRequests = 0;
      await browserContext.route("https://raw.githubusercontent.com/**", async (route) => {
        modelRequests += 1;
        await route.abort("failed");
      });
      const page = await browserContext.newPage();
      await page.goto(`${origin}/?section=captions`, { waitUntil: "networkidle" });
      await page.locator("#vosk-model-catalog-heading").waitFor();

      assert.equal(await page.locator("#caption-model-list .caption-model-option").count(), 13, name);
      assert.equal((await page.locator("#selected-caption-model").textContent()).trim(), "Deutsch", name);
      assert.equal(modelRequests, 0, `${name} downloaded a model before a click`);
      assert.deepEqual(await page.evaluate(() => window.__captionCaptureCalls), [], name);
      assert.equal(await page.locator("#toggle-live-captions").isDisabled(), true, name);

      await page.locator('input[name="captionAudioSource"][value="screen-audio"]').check();
      await page.waitForFunction(() => document.querySelector("#selected-caption-source")?.textContent?.trim() === "Bildschirmton");
      assert.equal((await page.locator("#selected-caption-source").textContent()).trim(), "Bildschirmton", name);
      assert.equal(await page.locator("#caption-share-with-room").isChecked(), false, `${name} expanded caption sharing without consent`);
      await page.locator("#caption-share-with-room").check();
      await page.waitForFunction(() => document.querySelector("#caption-sharing-state")?.textContent?.trim() === "lokal und im Raum");
      assert.equal((await page.locator("#caption-sharing-state").textContent()).trim(), "lokal und im Raum", name);
      await page.locator("#caption-share-with-room").uncheck();
      await page.waitForFunction(() => document.querySelector("#caption-sharing-state")?.textContent?.trim() === "nur auf diesem Gerät");
      assert.equal((await page.locator("#caption-sharing-state").textContent()).trim(), "nur auf diesem Gerät", name);
      assert.equal(modelRequests, 0, `${name} downloaded a model while selecting screen audio`);
      assert.deepEqual(await page.evaluate(() => window.__captionCaptureCalls), [], name);

      await page.locator("#caption-model-search").fill("português");
      assert.equal(await page.locator("#caption-model-list .caption-model-option").count(), 1, name);
      await page.locator("#caption-model-search").fill("");
      await page.locator("#load-vosk-model").click();
      await page.waitForFunction(() => document.querySelector(".caption-status-badge")?.getAttribute("data-status") === "error");
      assert.equal(modelRequests, 1, `${name} did not start exactly one explicit model request`);
      assert.deepEqual(await page.evaluate(() => window.__captionCaptureCalls), [], name);
      await browserContext.close();
    } finally {
      await browser.close();
    }
  }

  if (engines.length < 2) {
    context.diagnostic(`Browser matrix partial: installed ${engines.map(({ name }) => name).join(", ")}`);
  }
});
