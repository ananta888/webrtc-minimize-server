import assert from "node:assert/strict";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { nativeAudioOutputObservation } from "./helpers/native-audio-output.mjs";

const ladders = {
  "balanced-v1": [[640, 360, 15], [960, 540, 24], [1280, 720, 30]],
  "economy-v1": [[426, 240, 10], [640, 360, 15], [960, 540, 15]],
  "screen-v1": [[640, 360, 10], [960, 540, 10], [1280, 720, 10]],
};
for (const [profile, ladder] of Object.entries(ladders)) {
  test(`Angular ${profile} ladder reaches every admitted native HLS output without capture`, { timeout: 75000 }, async t => {
    if (process.platform !== "linux") { t.skip("Native process containment requires Linux and FFmpeg"); return; }
    const f = await nativeSceneLiveFixture(t, { outputProfile: "ladder-v1" }), { page } = f;
    await waitFixtureValue(page, async id => {
      const response = await fetch("/api/native-packagers", { headers: { authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
      return (await response.json()).packagers?.some(p => p.id === id && p.online && p.capability?.sourcePrograms);
    }, f.packagerId, { timeout: 15000 });
    const inventory = (await f.request("GET", "/api/native-packagers")).body;
    const capability = inventory.packagers.find(p => p.id === f.packagerId).capability;
    assert.equal(capability.maximumRenditions, 3);
    assert.equal(capability.maximumPixelsPerSecond, 43545600);
    assert.equal(capability.uploadClass, "over-15mbit");
    const admittedCount = { low: 1, medium: 2, high: 3 }[capability.cpuClass];
    assert.ok(admittedCount, "actual native CPU class must be known, never overridden");
    const ids = ["low", "medium", "high"].slice(0, admittedCount);
    assert.equal((await f.request("PUT", `/api/native-packagers/${f.packagerId}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
    await page.locator("#mesh-analysis-navigation").press("Enter");
    await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
    await page.locator("#broadcast-navigation").press("Enter");
    await page.locator("#native-source-program-open").press("Enter");
    await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
    await page.locator("#native-source-packager").selectOption(f.packagerId);
    await page.locator("#native-source-video-preset").selectOption(profile);
    await page.locator("#native-source-renditions").selectOption("3");
    assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
    const requests = [];
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/native-source-programs")) {
        const body = request.postDataJSON(); requests.push({ version: body.requestVersion, video: body.videoOutput,
          audio: body.audioOutput, requestedRenditions: body.requestedRenditions });
      }
    });
    const dialog = page.waitForEvent("dialog"), start = page.locator("#native-source-start").press("Enter");
    await (await dialog).accept(); await start;
    await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15000 });
    assert.deepEqual(requests, [{ version: 3, video: { profile }, audio: null, requestedRenditions: 3 }]);
    assert.equal(await page.locator("#native-source-video-preset").isDisabled(), true);
    const assignments = (await f.request("GET", "/api/native-packagers")).body.assignments;
    assert.equal(assignments.length, 1); assert.deepEqual(assignments[0].renditionIds, ids);
    const observed = {};
    let master;
    const deadline = performance.now() + 15000;
    do {
      for (const renditionId of ids) {
        if (!observed[renditionId]) {
          const output = await nativeAudioOutputObservation(f.output, { video: true, renditionId, master: true });
          observed[renditionId] = output.committed?.video;
          if (output.master) master = output.master;
        }
      }
      if (ids.every(id => observed[id]?.decodedFrames > 0)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    for (const [index, id] of ids.entries()) {
      const video = observed[id];
      assert.ok(video?.decodedFrames > 0, `${id} committed fragment must decode; an output ACK is insufficient`);
      assert.deepEqual([video.codec, video.width, video.height, video.framesPerSecond], ["h264", ...ladder[index]]);
    }
    assert.deepEqual(master, ids.map((id, index) => ({ id, width: ladder[index][0], height: ladder[index][1] })),
      "committed master must advertise exactly the admitted and decoded variants");
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, profile,
      requestedRenditions: 3, admittedRenditions: admittedCount, completeLadder: admittedCount === 3, video: observed }));
    await page.locator("#native-source-stop").click();
    await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  });
}
