import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

import { createAppServer } from "../src/server.js";

test("whiteboard & presentation: standalone drawing, keyboard shortcuts and stage switching", async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed");
    return;
  }

  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      signalBurstLimit: 240,
      maxSignalPayloadBytes: 65_536,
      auth: { mode: "disabled" },
      mediaE2ee: { mode: "preferred" },
    },
  });

  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream"],
  });

  context.after(async () => {
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // 1. Standalone navigation to whiteboard page
    await page.goto(`${origin}/?section=whiteboard`);
    await page.locator("#whiteboard-canvas").waitFor();

    // Verify standalone badge and drawing allowed before joining
    const standaloneBadge = await page.locator("#whiteboard-standalone-badge").textContent();
    assert.match(standaloneBadge, /Lokale Skizze/);

    // Verify tool selector and tools (1-7)
    await page.locator("#whiteboard-tool-select").waitFor();
    assert.equal(await page.locator("#whiteboard-tool-select").inputValue(), "pen");

    // Test keyboard shortcuts (1-7)
    await page.locator("#whiteboard-canvas").focus();
    await page.keyboard.press("2");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "mark");
    assert.equal(await page.locator("#whiteboard-tool-select").inputValue(), "mark");

    await page.keyboard.press("3");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "rectangle");

    await page.keyboard.press("4");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "ellipse");

    await page.keyboard.press("5");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "line");

    await page.keyboard.press("6");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "text");

    await page.keyboard.press("7");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "erase");

    await page.keyboard.press("1");
    await page.waitForFunction(() => document.querySelector("#whiteboard-tool-select")?.value === "pen");

    // Test slide deck controls
    assert.match(await page.locator("#whiteboard-slide-indicator").textContent(), /Folie 1 \/ 1/);
    await page.locator("#whiteboard-add-slide").click();
    await page.waitForFunction(() => document.querySelector("#whiteboard-slide-indicator")?.textContent?.includes("Folie 2 / 2"));
    assert.match(await page.locator("#whiteboard-slide-indicator").textContent(), /Folie 2 \/ 2/);

    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector("#whiteboard-slide-indicator")?.textContent?.includes("Folie 1 / 2"));
    assert.match(await page.locator("#whiteboard-slide-indicator").textContent(), /Folie 1 \/ 2/);

    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector("#whiteboard-slide-indicator")?.textContent?.includes("Folie 2 / 2"));
    assert.match(await page.locator("#whiteboard-slide-indicator").textContent(), /Folie 2 \/ 2/);

    // Verify export buttons exist
    await page.locator("#whiteboard-export-png").waitFor();
    await page.locator("#whiteboard-export-pdf").waitFor();

    // 2. Test live room stage switching & empty room button
    await page.goto(`${origin}/?section=live`);
    await page.locator("#empty-media").waitFor();

    // Prominent "Tafel auf Bühne öffnen" button in empty room
    const openStageBtn = page.locator("#open-stage-whiteboard-btn");
    await openStageBtn.waitFor();
    await openStageBtn.click();

    // Stage should now display the whiteboard container
    await page.locator("#stage-whiteboard-container").waitFor();
    await page.locator("#stage-whiteboard-container #whiteboard-canvas").waitFor();

    // Switch back to media view
    await page.locator("#stage-view-media-btn").click();
    await page.locator("#media-grid").waitFor();

    // Switch to whiteboard view via switcher
    await page.locator("#stage-view-whiteboard-btn").click();
    await page.locator("#stage-whiteboard-container").waitFor();

    assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join(", ")}`);
    await page.close();
  } catch (err) {
    throw err;
  }
});
