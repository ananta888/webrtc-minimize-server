import assert from "node:assert/strict";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { decodedScene, decodedSceneTiles, openSceneViewer, sceneViewerObservation } from "./helpers/native-scene-viewer.mjs";
import { assertFreshNativeSceneApply } from "./helpers/native-scene-reply-observation.mjs";

async function confirm(page, action) {
  const dialog = page.waitForEvent("dialog"), pending = action();
  await (await dialog).accept(); await pending;
}

for (const multiple of [false, true]) test(multiple
  ? "coupled Angular director preserves a second source through two encoder replacements"
  : "coupled Angular director uses actual native source-program authority", { timeout: 180_000 }, async t => {
  if (process.platform !== "linux") { t.skip("Coupled production-process fixture requires Linux containment and local FFmpeg"); return; }
  const f = await nativeSceneLiveFixture(t, { allowSyntheticScreen: multiple }), { page } = f;
  await waitFixtureValue(page, async id => {
    const response = await fetch("/api/native-packagers", { headers: {
      authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
    const value = await response.json();
    return value.packagers?.some(p => p.id === id && p.online && p.capability?.sourcePrograms === true);
  }, f.packagerId, { timeout: 15_000 });
  assert.equal(f.agent.alive(), true); assert.equal(f.gateway.alive(), true);
  assert.equal((await f.request("PUT", `/api/native-packagers/${f.packagerId}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
  await page.locator("#mesh-analysis-navigation").press("Enter");
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator("#broadcast-navigation").press("Enter");
  await page.locator("#native-source-program-open").press("Enter");
  await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
  await page.locator("#native-source-packager").selectOption(f.packagerId);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  await confirm(page, () => page.locator("#native-source-start").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15_000 }).catch(async error => {
    t.diagnostic(JSON.stringify({ stage: "initial-output", agentAlive: f.agent.alive(), originAlive: f.gateway.alive(),
      ui: await page.locator("#native-source-status").innerText(),
      error: await page.locator("app-native-source-program .error").allTextContents(), observation: f.observation }));
    throw error;
  });
  await page.locator("#native-scene-refresh").click();
  await page.locator("#native-scene-status", { hasText: "Szenenzustand bestätigt" }).waitFor();
  await page.locator("#native-scene-layout:not([disabled])").waitFor();
  assert.equal(await page.locator("#native-scene-layout").isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  const viewer = await openSceneViewer(f);
  const initial = await decodedScene(viewer, "slate");
  assert.equal(f.app.registry.participantCount, 1, "HLS viewer does not join room membership");
  await page.locator("#toggle-camera").click();
  await page.locator('#toggle-camera[aria-pressed="true"]').waitFor();
  await page.locator("#broadcast-source-requests-open").click();
  const sources = page.locator("app-broadcast-source-requests");
  await confirm(page, () => sources.locator("#broadcast-source-request-own").click());
  await sources.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).click();
  await sources.locator("#broadcast-source-approval select").selectOption("300000");
  await confirm(page, () => sources.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
  await sources.locator("li", { hasText: "Sender aktiv" }).waitFor({ timeout: 15_000 });
  if (multiple) {
    await page.locator("#toggle-screen").click();
    await page.locator('#toggle-screen[aria-pressed="true"]').waitFor();
    await sources.locator("#broadcast-source-request-kind").selectOption("screen");
    await confirm(page, () => sources.locator("#broadcast-source-request-own").click());
    await sources.locator("li[data-source-request-id]", { hasText: "· Bildschirm ·" })
      .getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).click();
    await sources.locator("#broadcast-source-approval select").selectOption("300000");
    await confirm(page, () => sources.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
    await sources.locator("li", { hasText: "Sender aktiv" }).filter({ hasText: "Bildschirm" }).waitFor({ timeout: 15_000 });
  }
  await page.locator("#native-scene-refresh").click();
  await page.locator("#native-scene-status", { hasText: "Szenenzustand bestätigt" }).waitFor();
  await page.locator("#native-scene-layout").selectOption(multiple ? "side-by-side" : "single");
  await page.locator("app-native-source-scene").getByRole("checkbox", { name: /Kamera/ }).check();
  if (multiple) await page.locator("app-native-source-scene").getByRole("checkbox", { name: /Bildschirm/ }).check();
  const queriedScene = f.observation.scene.at(-1);
  await confirm(page, () => page.locator("#native-scene-apply").click());
  await page.locator("#native-scene-status", { hasText: "neu abfragen" }).waitFor();
  try { assertFreshNativeSceneApply(f.observation.scene, queriedScene); }
  catch (error) { t.diagnostic(JSON.stringify({ stage: "scene-application-receipt", scene: f.observation.scene })); throw error; }
  const red = await (multiple ? decodedSceneTiles(viewer, ["red", "blue"]) : decodedScene(viewer, "red", initial.time + 1)).catch(async error => {
    t.diagnostic(JSON.stringify({ stage: "selected-source-output", initial, viewer: await sceneViewerObservation(viewer),
      agentAlive: f.agent.alive(), originAlive: f.gateway.alive(), observation: f.observation }));
    throw error;
  });
  await sources.locator("li", { hasText: "Sender aktiv" }).filter({ hasText: "Kamera" })
    .getByRole("button", { name: "Broadcast-Quelle sofort stoppen", exact: true }).click();
  const revoked = await (multiple ? decodedSceneTiles(viewer, ["slate", "blue"]) : decodedScene(viewer, "slate", red.time + 1)).catch(async error => {
    t.diagnostic(JSON.stringify({ stage: "source-revoked", initial, red, viewer: await sceneViewerObservation(viewer),
      program: await page.locator("#native-source-status").innerText(), observation: f.observation }));
    throw error;
  });
  assert.equal(await page.locator("#toggle-camera").getAttribute("aria-pressed"), "true", "source revoke keeps room camera alive");
  assert.equal(await page.evaluate(() => window.__sceneCaptures), multiple ? 2 : 1);
  if (!multiple) assert.ok(revoked.decodedFrames > red.decodedFrames && red.decodedFrames > initial.decodedFrames);
  let finalSlate, survivingMovement;
  if (multiple) {
    survivingMovement = await decodedSceneTiles(viewer, ["slate", "blue"], revoked.pixels[1][2]);
    assert.ok(survivingMovement.decodedFrames > revoked.decodedFrames, "remaining source continues decoding after the first revoke");
    assert.equal(await page.locator("#toggle-screen").getAttribute("aria-pressed"), "true");
    await sources.locator("li", { hasText: "Sender aktiv" }).filter({ hasText: "Bildschirm" })
      .getByRole("button", { name: "Broadcast-Quelle sofort stoppen", exact: true }).click();
    finalSlate = await decodedSceneTiles(viewer, ["slate", "slate"]);
    assert.equal(await page.locator("#toggle-screen").getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.__sceneCaptures), 2);
    assert.equal(f.app.registry.participantCount, 1);
  }
  t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, path: "Angular-Node-native-SFrame-HLS-viewer",
    initial, red, revoked, survivingMovement, finalSlate, roomParticipants: f.app.registry.participantCount }));
  await viewer.close();
  await page.locator("#native-source-stop").click();
  await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15_000 });
});
