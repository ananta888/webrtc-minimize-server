import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { createAppServer } from "../src/server.js";

for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) {
  for (const scenario of ["delayed", "failed-reload"]) {
    test(`${name} keeps ${scenario} runtime bootstrap closed until explicit readiness without capture or login`, { timeout: 30_000 }, async t => {
      if (!fs.existsSync(engine.executablePath())) { t.skip(`Install Playwright ${name} for this real bootstrap gate`); return; }
      const app = createAppServer({ config: { host: "127.0.0.1", port: 0, publicOrigin: "", stunUrls: [], turnServers: [],
        maxRoomParticipants: 20, roomIdleTtlMs: 60_000, signalRateLimit: 120, pairWorkspaceEnabled: false } });
      await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
      let browser, release = () => {};
      t.after(async () => { release(); await browser?.close(); for (const socket of app.webSocketServer.clients) socket.terminate();
        await new Promise(resolve => app.server.close(resolve)); });
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage(), errors = [];
      page.setDefaultTimeout(5_000);
      let captures = 0, discovery = 0, configRequests = 0;
      page.on("pageerror", error => errors.push(error.message));
      await page.exposeFunction("recordForbiddenCapture", () => { captures++; throw new Error("Capture forbidden in bootstrap fixture"); });
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => window.recordForbiddenCapture();
        navigator.mediaDevices.getDisplayMedia = () => window.recordForbiddenCapture();
      });
      await page.route("https://identity.test/**", route => { discovery++; return route.abort(); });
      const held = new Promise(resolve => { release = resolve; });
      await page.route("**/config", async route => {
        configRequests++;
        if (scenario === "failed-reload" && configRequests === 1) return route.fulfill({ status: 503, json: {} });
        const upstream = await route.fetch();
        const config = await upstream.json();
        config.auth = { ...config.auth, mode: "required", issuer: "https://identity.test/realms/fixture",
          clientId: "fixture", audience: "fixture" };
        if (scenario === "delayed") await held;
        await route.fulfill({ json: config });
      });
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator("#login").waitFor();
      assert.equal(await page.locator("#login").isDisabled(), true);
      assert.equal(await page.locator("#register").isDisabled(), true);
      await page.locator("#login").evaluate(button => button.click());
      await page.locator("#register").evaluate(button => button.click());
      assert.equal(discovery, 0); assert.equal(captures, 0);
      if (scenario === "delayed") {
        assert.equal(await page.locator("#runtime-config-status").getAttribute("data-state"), "loading");
        release();
      } else {
        await page.locator('#runtime-config-status[data-state="failed"]').waitFor();
        await page.locator("#runtime-config-reload").click();
      }
      await page.locator('#runtime-config-status[data-state="ready"]').waitFor({ state: "attached" });
      assert.equal(await page.locator("#login").isEnabled(), true);
      assert.equal(await page.locator("#register").isEnabled(), true);
      assert.equal(configRequests, scenario === "delayed" ? 1 : 2);
      assert.equal(discovery, 0); assert.equal(captures, 0);
      assert.equal(new URL(page.url()).origin, origin);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("webrtc.oidc.pkce")), null);
      assert.deepEqual(errors, []);
    });
  }
}
