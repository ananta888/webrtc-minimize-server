import assert from "node:assert/strict";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { nativeAudioOutputObservation } from "./helpers/native-audio-output.mjs";

for (const [profile, width, height, fps] of [["balanced-v1", 640, 360, 15], ["economy-v1", 426, 240, 10], ["screen-v1", 640, 360, 10]]) {
  test(`Angular ${profile} choice reaches decoded native HLS output without capture`, { timeout: 75000 }, async t => {
    if (process.platform !== "linux") { t.skip("Native process containment requires Linux and FFmpeg"); return; }
    const f = await nativeSceneLiveFixture(t), { page } = f;
    await waitFixtureValue(page, async id => {
      const response = await fetch("/api/native-packagers", { headers: { authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
      return (await response.json()).packagers?.some(p => p.id === id && p.online && p.capability?.sourcePrograms);
    }, f.packagerId, { timeout: 15000 });
    assert.equal((await f.request("PUT", `/api/native-packagers/${f.packagerId}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
    await page.locator("#mesh-analysis-navigation").press("Enter");
    await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
    await page.locator("#broadcast-navigation").press("Enter");
    await page.locator("#native-source-program-open").press("Enter");
    await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
    await page.locator("#native-source-packager").selectOption(f.packagerId);
    await page.locator("#native-source-video-preset").selectOption(profile);
    assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
    const requests = [];
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/native-source-programs")) {
        const body = request.postDataJSON(); requests.push({ version: body.requestVersion, video: body.videoOutput, audio: body.audioOutput });
      }
    });
    const dialog = page.waitForEvent("dialog"), start = page.locator("#native-source-start").press("Enter");
    await (await dialog).accept(); await start;
    await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15000 });
    assert.deepEqual(requests, [{ version: 3, video: { profile }, audio: null }]);
    assert.equal(await page.locator("#native-source-video-preset").isDisabled(), true);
    let observed;
    const deadline = performance.now() + 15000;
    do {
      observed = (await nativeAudioOutputObservation(f.output, { video: true })).committed?.video;
      if (observed?.decodedFrames > 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    assert.ok(observed?.decodedFrames > 0, "committed fragment must decode; an output ACK is insufficient");
    assert.deepEqual([observed.codec, observed.width, observed.height, observed.framesPerSecond], ["h264", width, height, fps]);
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, profile, video: observed }));
    await page.locator("#native-source-stop").click();
    await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  });
}
