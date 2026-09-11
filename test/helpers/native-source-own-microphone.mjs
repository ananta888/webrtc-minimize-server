import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { nativeAudioOutputObservation } from "./native-audio-output.mjs";

export async function confirm(page, action, accept = true) {
  const dialog = page.waitForEvent("dialog"), pending = action(), opened = await dialog;
  if (accept) await opened.accept(); else await opened.dismiss();
  await pending;
}

/** Rendered controls only; every consent is an explicit confirmed click. */
export async function publishOwnMicrophone(page) {
  if (await page.locator("#broadcast-source-requests-open").count()) await page.locator("#broadcast-source-requests-open").click();
  const panel = page.locator("app-broadcast-source-requests");
  await panel.locator("#broadcast-source-request-kind").selectOption("microphone");
  await confirm(page, () => panel.locator("#broadcast-source-request-own").press("Enter"));
  await panel.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).last().click();
  await panel.locator("#broadcast-source-approval select").selectOption("300000");
  await confirm(page, () => panel.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
  await panel.locator("li", { hasText: "Sender aktiv" }).waitFor({ timeout: 15000 });
}

export async function outputAudio(root, audible) {
  const deadline = performance.now() + 15000;
  do {
    const value = (await nativeAudioOutputObservation(root, { encoding: true })).committed;
    if (value?.audio?.decoded && value.encoding?.codec === "aac" && value.encoding.sampleRate === 48000
      && value.encoding.channels === 1 && value.audio.channels.every(rms => audible ? rms > .01 : rms < .001)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  assert.fail(audible ? "consented successor must emit mono AAC tone" : "successor must emit silent mono AAC before new consent");
}

export const resources = async root => (await fs.readdir(root)).filter(name => /^res_[A-Za-z0-9_-]{16,64}$/.test(name));
