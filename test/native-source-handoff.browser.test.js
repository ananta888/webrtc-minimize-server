import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { nativeAudioOutputObservation } from "./helpers/native-audio-output.mjs";

async function confirm(page, action, accept = true) {
  const dialog = page.waitForEvent("dialog"), pending = action(), opened = await dialog;
  if (accept) await opened.accept(); else await opened.dismiss();
  await pending;
}
async function publishOwnMicrophone(page) {
  if (await page.locator("#broadcast-source-requests-open").count()) await page.locator("#broadcast-source-requests-open").click();
  const panel = page.locator("app-broadcast-source-requests");
  await panel.locator("#broadcast-source-request-kind").selectOption("microphone");
  await confirm(page, () => panel.locator("#broadcast-source-request-own").press("Enter"));
  await panel.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).last().click();
  await panel.locator("#broadcast-source-approval select").selectOption("300000");
  await confirm(page, () => panel.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
  await panel.locator("li", { hasText: "Sender aktiv" }).waitFor({ timeout: 15000 });
}
async function outputAudio(root, audible) {
  const deadline = performance.now() + 15000;
  do {
    const value = (await nativeAudioOutputObservation(root, { encoding: true })).committed;
    if (value?.audio?.decoded && value.encoding?.codec === "aac" && value.encoding.sampleRate === 48000
      && value.encoding.channels === 1 && value.audio.channels.every(rms => audible ? rms > .01 : rms < .001)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  assert.fail(audible ? "consented successor must emit mono AAC tone" : "successor must emit silent mono AAC before new consent");
}
const resources = async root => (await fs.readdir(root)).filter(name => /^res_[A-Za-z0-9_-]{16,64}$/.test(name));

test("rendered source handoff drains the real writer, preserves mono AAC and requires fresh source consent", { timeout: 120000 }, async t => {
  if (process.platform !== "linux") { t.skip("Two native processes require Linux containment and local FFmpeg"); return; }
  const f = await nativeSceneLiveFixture(t, { packagerCount: 2, allowSyntheticAudio: true }), { page } = f;
  page.setDefaultTimeout(5000);
  let verified = false;
  t.after(() => { if (!verified) t.diagnostic(JSON.stringify({ synthetic: true, observation: f.observation })); });
  await waitFixtureValue(page, async ids => {
    const r = await fetch("/api/native-packagers", { headers: { authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
    const rows = (await r.json()).packagers;
    return ids.every(id => rows?.some(p => p.id === id && p.online && p.capability?.capabilityVersion === 5));
  }, f.packagerIds, { timeout: 15000 });
  for (const id of f.packagerIds) assert.equal((await f.request("PUT", `/api/native-packagers/${id}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
  await page.locator("#mesh-analysis-navigation").press("Enter");
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator("#broadcast-navigation").press("Enter"); await page.locator("#native-source-program-open").press("Enter");
  await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
  await page.locator("#native-source-packager").selectOption(f.packagerId);
  await page.locator("#native-source-audio-preset").selectOption("speech");
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  await confirm(page, () => page.locator("#native-source-start").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15000 });
  await page.locator("#toggle-microphone").click(); await publishOwnMicrophone(page);
  const before = await outputAudio(f.output, true), oldResources = await resources(f.output);
  assert.equal(oldResources.length, 1);
  const old = (await f.request("GET", "/api/native-packagers")).body.assignments.find(a => a.packagerId === f.packagerId && a.state === "running");
  assert.ok(old);
  await page.locator("#native-source-handoff-packager").selectOption(f.packagerIds[1]);
  await confirm(page, () => page.locator("#native-source-handoff").press("Enter"), false);
  assert.equal((await f.request("GET", "/api/native-packagers")).body.assignments.filter(a => a.state === "running").length, 1);
  await confirm(page, () => page.locator("#native-source-handoff").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Übergabe läuft" }).waitFor();
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 20000 });
  await page.locator("#native-source-confirmed-packager", { hasText: "Successor scene fixture" }).waitFor();
  const rows = (await f.request("GET", "/api/native-packagers")).body.assignments;
  assert.equal(rows.find(a => a.assignmentId === old.assignmentId)?.state, "stopped");
  const active = rows.filter(a => !["stopped", "failed"].includes(a.state));
  assert.equal(active.length, 1); assert.equal(active[0].packagerId, f.packagerIds[1]);
  assert.equal(active[0].programEpoch, old.programEpoch + 1); assert.ok(active[0].fencingRevision > old.fencingRevision);
  const silent = await outputAudio(f.output, false), newResources = await resources(f.output);
  assert.equal(newResources.length, 1); assert.notEqual(newResources[0], oldResources[0]);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1, "handoff cannot capture or restart a room source");
  assert.equal(await page.locator("#toggle-microphone").getAttribute("aria-pressed"), "true");
  await page.locator("#native-audio-refresh").click();
  await page.locator("#native-audio-status", { hasText: "Audiowerte bestätigt" }).waitFor();
  await page.locator("app-native-source-audio").getByText("48 kbit/s Zielrate.", { exact: false }).waitFor();
  await publishOwnMicrophone(page);
  const after = await outputAudio(f.output, true);
  await page.locator("#native-source-stop").press("Enter");
  await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15000 });
  assert.equal((await f.request("GET", "/api/native-packagers")).body.assignments.every(a => a.state === "stopped"), true);
  assert.deepEqual(await resources(f.output), []); assert.equal(f.agent.alive(), true); assert.equal(f.successorAgent.alive(), true);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1); await page.locator("#toggle-microphone").click();
  t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, nativeProcesses: 2, oldWriterStopped: true,
    epochAdvanced: true, newConsentRequired: true, before: before.encoding, silent: silent.encoding, after: after.encoding }));
  verified = true;
});
