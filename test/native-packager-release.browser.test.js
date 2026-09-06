import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { createAppServer } from "../src/server.js";
import { RELEASE_TARGETS, artifactFilename } from "../src/native-packager-release.js";

for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) {
  test(`${name} renders explicit per-device update help without capture, enrollment or false verification`, { timeout: 25_000 }, async t => {
    if (!fs.existsSync(engine.executablePath())) { t.skip(`Install Playwright ${name} for this real UI gate`); return; }
    const app = createAppServer({ config: { host: "127.0.0.1", port: 0, publicOrigin: "", stunUrls: [], turnServers: [],
      maxRoomParticipants: 20, roomIdleTtlMs: 60_000, signalRateLimit: 120, pairWorkspaceEnabled: false, nativePackagerSelfServiceEnabled: true } });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const browser = await engine.launch({ headless: true });
    t.after(async () => { await browser.close(); for (const socket of app.webSocketServer.clients) socket.terminate(); await new Promise(resolve => app.server.close(resolve)); });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__releaseCaptureCalls = 0;
      const denied = async () => { window.__releaseCaptureCalls++; throw new Error("Capture forbidden in update UI test"); };
      navigator.mediaDevices.getUserMedia = denied; navigator.mediaDevices.getDisplayMedia = denied;
    });
    const packager = { id: "pkr_0123456789abcdef", label: "Synthetic Linux Packager", platform: "linux", keyFingerprint: "A".repeat(43),
      createdAt: 1, lastAuthenticatedAt: 2, revokedAt: 0, online: true, consentedRoomIds: [], confirmedRoomIds: [], capability: null, heartbeat: null };
    const manifest = { version: 1, type: "native-packager-release", repository: "ananta888/webrtc-minimize-server",
      workflow: "ananta888/webrtc-minimize-server/.github/workflows/ci.yml", revision: "a".repeat(40), builtAt: "2026-09-06T10:00:00Z", agentVersion: "0.7.0", goVersion: "go1.24.13",
      artifacts: RELEASE_TARGETS.map(target => ({ target, filename: artifactFilename(target), sha256: "b".repeat(64), bytes: 1234 })) };
    let fetches = 0, enrollments = 0, invalid = false;
    await page.route("**/api/native-packagers", route => route.fulfill({ json: { packagers: [packager], assignments: [] } }));
    await page.route("**/api/native-packagers/enrollments", route => { enrollments++; return route.fulfill({ status: 403, json: {} }); });
    await page.route("**/downloads/native-packager/release.json", route => { fetches++; return route.fulfill({ json: invalid ? { ...manifest, verified: true } : manifest }); });
    await page.goto(`http://127.0.0.1:${app.server.address().port}/?section=analysis`);
    await page.locator("#mesh-analysis-navigation").click();
    const panel = page.locator("#native-packager-analysis-panel");
    await panel.getByRole("button", { name: "Aktualisieren", exact: true }).click();
    const update = panel.locator("app-native-packager-update");
    await update.locator("summary").focus(); await page.keyboard.press("Enter");
    assert.equal(fetches, 0);
    await update.getByRole("button", { name: "Release-Daten laden" }).click();
    await update.getByText("Noch nicht unabhängig verifiziert.", { exact: false }).waitFor();
    const select = update.getByLabel("Architektur dieses Agent-Rechners");
    assert.deepEqual(await select.locator("option").evaluateAll(items => items.map(item => item.value)), ["", "linux-amd64", "linux-arm64"]);
    await select.selectOption("linux-amd64");
    await update.locator("pre").filter({ hasText: `update-${packager.id}` }).waitFor();
    const text = await update.innerText();
    assert.ok(text.includes(`--source-digest ${manifest.revision}`)); assert.ok(text.includes(manifest.artifacts[0].sha256));
    assert.ok(text.includes("--source-ref refs/heads/main --deny-self-hosted-runners"));
    assert.equal(await update.getByRole("link", { name: "Binärdatei zur Prüfung" }).getAttribute("href"), "/downloads/native-packager/linux-amd64");
    invalid = true; await update.getByRole("button", { name: "Release-Daten laden" }).click();
    await update.getByRole("alert").waitFor(); assert.equal(await update.locator("pre").count(), 0);
    assert.equal(await page.evaluate(() => window.__releaseCaptureCalls), 0); assert.equal(enrollments, 0); assert.equal(fetches, 2);
  });
}
