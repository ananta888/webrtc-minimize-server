import assert from "node:assert/strict";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { nativeAudioOutputObservation } from "./helpers/native-audio-output.mjs";

async function confirm(page, action) {
  const dialog = page.waitForEvent("dialog"), pending = action();
  await (await dialog).accept(); await pending;
}
for (const preset of ["speech", "music"]) test(`rendered ${preset} selection reaches actual native AAC output without changing room capture`, { timeout: 100000 }, async t => {
  if (process.platform !== "linux") { t.skip("Actual native process requires Linux containment and local FFmpeg"); return; }
  const f = await nativeSceneLiveFixture(t, { allowSyntheticAudio: true }), { page } = f;
  page.setDefaultTimeout(5000);
  await waitFixtureValue(page, async id => {
    const response = await fetch("/api/native-packagers", { headers: {
      authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
    return (await response.json()).packagers?.some(p => p.id === id && p.online && p.capability?.capabilityVersion === 5
      && p.capability.sourceAudioControlVersion === 3 && p.capability.sourceAudioEncodingVersion === 1);
  }, f.packagerId, { timeout: 15000 });
  assert.equal((await f.request("PUT", `/api/native-packagers/${f.packagerId}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
  await page.locator("#mesh-analysis-navigation").press("Enter");
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator("#broadcast-navigation").press("Enter");
  await page.locator("#native-source-program-open").press("Enter");
  await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
  await page.locator("#native-source-packager").selectOption(f.packagerId);
  await page.locator("#native-source-audio-preset").selectOption(preset);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  await confirm(page, () => page.locator("#native-source-start").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#native-source-audio-preset").isDisabled(), true);
  const audio = page.locator("app-native-source-audio");
  await audio.locator("#native-audio-refresh").click();
  await audio.locator("#native-audio-status", { hasText: "Audiowerte bestätigt" }).waitFor();
  const channels = preset === "speech" ? 1 : 2, rate = preset === "speech" ? 48000 : 192000;
  await audio.getByText(`AAC · 48000 Hz · ${channels} Kanäle.`, { exact: false }).waitFor();
  await audio.getByText(`${rate / 1000} kbit/s Zielrate.`, { exact: false }).waitFor();
  await page.locator("#toggle-microphone").click();
  await page.locator('#toggle-microphone[aria-pressed="true"]').waitFor();
  await page.locator("#broadcast-source-requests-open").click();
  const sources = page.locator("app-broadcast-source-requests");
  await sources.locator("#broadcast-source-request-kind").selectOption("microphone");
  await confirm(page, () => sources.locator("#broadcast-source-request-own").click());
  await sources.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).click();
  await sources.locator("#broadcast-source-approval select").selectOption("300000");
  await confirm(page, () => sources.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
  await sources.locator("li", { hasText: "Sender aktiv" }).waitFor({ timeout: 15000 });
  let output, confirmed = false;
  const deadline = performance.now() + 15000;
  do {
    output = await nativeAudioOutputObservation(f.output, { encoding: true });
    const observed = output.committed;
    confirmed = observed?.audio?.decoded && observed.audio.channels.every(rms => rms > .01)
      && observed.encoding?.channels === channels && observed.encoding.codec === "aac" && observed.encoding.sampleRate === 48000;
    if (confirmed) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  assert.equal(confirmed, true, "committed AAC must contain the selected channel format and decoded non-silent tone");
  assert.ok(output.committed.encoding.measuredBitsPerSecond <= rate * 1.5 + 10000, "AAC target is not a CBR guarantee");
  t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, preset, targetBitsPerSecond: rate, output: output.committed }));
  await page.locator("#native-source-stop").click();
  await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1);
  assert.equal(await page.locator("#toggle-microphone").getAttribute("aria-pressed"), "true", "stopping broadcast cannot stop the room microphone");
  await page.locator("#toggle-microphone").click();
});
