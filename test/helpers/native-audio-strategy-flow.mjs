import assert from "node:assert/strict";
import { waitNativeAudioStrategy } from "./native-audio-frequency.mjs";

/** Uses only rendered controls and actual native receipts; no direct DSP seam. */
export async function nativeAudioStrategyFlow({ page, audio, sources, query, confirm, viewer, stage, output, strategies }) {
  assert.ok([JSON.stringify(["balanced", "speech-first"]), JSON.stringify(["screen-first", "unprocessed"])].includes(JSON.stringify(strategies)));
  stage("screen-audio-consent");
  await page.locator("#toggle-screen").click();
  await page.locator('#toggle-screen[aria-pressed="true"]').waitFor();
  await sources.locator("#broadcast-source-request-kind").selectOption("screen-audio");
  await confirm(page, () => sources.locator("#broadcast-source-request-own").click());
  const request = sources.locator("li[data-source-request-id]", { hasText: "· Bildschirmton ·" });
  await request.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).click();
  await sources.locator("#broadcast-source-approval select").selectOption("300000");
  await confirm(page, () => sources.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
  const screen = sources.locator("li", { hasText: /^Bildschirmton ·/ });
  await screen.filter({ hasText: "Sender aktiv" }).waitFor({ timeout: 15000 });
  stage("two-tone-baseline");
  output.baseline = await waitNativeAudioStrategy(viewer, "unprocessed");
  const before = await query();
  assert.deepEqual(before.sources.map(source => source.sourceKind).sort(), ["microphone", "screen-audio"]);
  assert.equal(before.mix.strategy, "unprocessed");
  assert.equal(before.encoding.codec, "aac"); assert.equal(before.encoding.sampleRate, 48000);
  assert.equal(before.encoding.channels, 2); assert.equal(before.encoding.renditions.length, 1);
  assert.ok(before.encoding.renditions[0].targetBitsPerSecond > 0);
  for (const strategy of strategies) {
    stage(`strategy-${strategy}`);
    const previous = await query();
    await audio.locator("#native-audio-strategy").selectOption(strategy);
    await confirm(page, () => audio.locator("#native-audio-apply").press("Enter"));
    await audio.locator("#native-audio-status", { hasText: "neu abfragen" }).waitFor();
    const observed = await query();
    assert.equal(observed.mix.strategy, strategy);
    assert.equal(observed.audioRevision, previous.audioRevision + 1);
    assert.deepEqual(observed.sources, previous.sources, "strategy selection preserves individual gains and mute");
    assert.deepEqual(observed.encoding, before.encoding, "DSP switch cannot change AAC/HLS format");
    output[strategy] = await waitNativeAudioStrategy(viewer, strategy, output.baseline);
  }
  return screen;
}
