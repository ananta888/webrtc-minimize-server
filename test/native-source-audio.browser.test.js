import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { openSceneViewer, sceneViewerObservation } from "./helpers/native-scene-viewer.mjs";
import { startNativeAudioProbe, waitNativeAudioLevel, stopNativeAudioProbe } from "./helpers/native-audio-viewer.mjs";
import { nativeAudioOutputObservation } from "./helpers/native-audio-output.mjs";
import { nativeAudioStrategyFlow } from "./helpers/native-audio-strategy-flow.mjs";

async function confirm(page, action, accepted = true) {
  const dialog = page.waitForEvent("dialog"), pending = action();
  const prompt = await dialog;
  if (accepted) await prompt.accept(); else await prompt.dismiss();
  await pending;
}

// Separate fresh programs keep both acceptance paths inside their real short
// consent leases. Strategy changes must not silently renew a source consent.
for (const strategies of [null, ["balanced", "speech-first"], ["screen-first", "unprocessed"]]) test(`rendered Angular audio controls actual native ${strategies ? "two-source priorities " + strategies.join("+") : "gain/mute"} without expanding consent`, { timeout: 150_000 }, async t => {
  if (process.platform !== "linux") { t.skip("Actual native production process requires Linux containment and local FFmpeg"); return; }
  const f = await nativeSceneLiveFixture(t, { allowSyntheticAudio: true, allowSyntheticScreen: Boolean(strategies), allowSyntheticScreenAudio: Boolean(strategies) }), { page } = f;
  page.setDefaultTimeout(5000);
  let stage = "setup";
  const replies = [];
  const audioOutput = {};
  const nativeEvents = new EventEmitter();
  // Read actual native wire receipts rather than CDP's evictable HTTP-body
  // cache. This listener cannot send, acknowledge or alter any control message.
  const observe = socket => socket.on("message", bytes => {
    if (bytes.length > 16384 || replies.length >= 32) return;
    try {
      const value = JSON.parse(bytes.toString());
      if (value.type === "assignment-status" && value.state === "running" && value.reasonCode === "OUTPUT_READY") {
        nativeEvents.emit("output-ready");
      }
      if (["source-program-audio-state", "source-program-audio-applied", "source-program-audio-rejected"].includes(value.type)) {
        replies.push({ type: value.type, audioRevision: value.audioRevision, sources: value.sources, mix: value.mix, encoding: value.encoding });
      }
    } catch { /* No raw payload diagnostic. */ }
  });
  for (const socket of f.app.nativePackagerWebSocketServer.clients) observe(socket);
  f.app.nativePackagerWebSocketServer.on("connection", observe);
  t.after(() => t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false,
    stage,
    audioOutput,
    audioReplies: replies.map(r => ({ outcome: r.type, revision: r.audioRevision, sources: r.sources?.length })), observation: f.observation })));
  await waitFixtureValue(page, async id => {
    const response = await fetch("/api/native-packagers", { headers: {
      authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
    return (await response.json()).packagers?.some(p => p.id === id && p.online
      && p.capability?.capabilityVersion === 6 && p.capability.sourceSceneControlVersion === 2 && p.capability.sourceAudioControlVersion === 3 && p.capability.sourceAudioEncodingVersion === 1);
  }, f.packagerId, { timeout: 15_000 });
  assert.equal((await f.request("PUT", `/api/native-packagers/${f.packagerId}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
  // Explicit local setting before program start; setting alone never captures.
  if (strategies) {
    await page.locator(".nav-item", { hasText: "Einstellungen" }).click();
    await page.locator("#screen-audio-enabled").check();
  }
  await page.locator("#mesh-analysis-navigation").press("Enter");
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator("#broadcast-navigation").press("Enter");
  await page.locator("#native-source-program-open").press("Enter");
  await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
  await page.locator("#native-source-packager").selectOption(f.packagerId);
  await confirm(page, () => page.locator("#native-source-start").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15_000 });
  const audio = page.locator("app-native-source-audio");
  stage = "empty-query";
  const query = async () => {
    const before = replies.length;
    const received = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/native-source-audio") && r.request().postDataJSON().action === "query");
    await audio.locator("#native-audio-refresh").press("Enter");
    const response = await received; assert.equal(response.status(), 200);
    await audio.locator("#native-audio-status", { hasText: "Audiowerte bestätigt" }).waitFor();
    const result = replies.slice(before).find(r => r.type === "source-program-audio-state");
    assert.ok(result, "rendered state has an actual native query receipt");
    return result;
  };
  assert.deepEqual((await query()).sources, []);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  assert.equal(await audio.locator("#native-audio-apply").isDisabled(), false, "negotiated strategy control can apply before inputs arrive");
  const viewer = await openSceneViewer(f);
  await startNativeAudioProbe(viewer);
  const measure = async (mode, baseline = null) => {
    try { return await waitNativeAudioLevel(viewer, mode, baseline); }
    catch (error) {
      t.diagnostic(JSON.stringify({ stage, output: await nativeAudioOutputObservation(f.output),
        viewer: await sceneViewerObservation(viewer) }));
      throw error;
    }
  };

  await page.locator("#toggle-microphone").click();
  stage = "source-consent";
  await page.locator('#toggle-microphone[aria-pressed="true"]').waitFor();
  await page.locator("#broadcast-source-requests-open").click();
  const sources = page.locator("app-broadcast-source-requests");
  await sources.locator("#broadcast-source-request-kind").selectOption("microphone");
  await confirm(page, () => sources.locator("#broadcast-source-request-own").click());
  await sources.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).click();
  await sources.locator("#broadcast-source-approval select").selectOption("300000");
  await confirm(page, () => sources.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).click());
  await sources.locator("li", { hasText: "Sender aktiv" }).waitFor({ timeout: 15_000 });
  if (!strategies) {
  stage = "initial-output-tone";
  audioOutput.initial = await measure("tone");
  const initial = await query();
  stage = "gain-mute";
  assert.equal(initial.sources.length, 1);
  assert.equal(initial.sources[0].sourceKind, "microphone");
  assert.equal(initial.sources[0].muted, false);
  const applyCount = () => replies.filter(r => r.type === "source-program-audio-applied").length;
  await audio.getByLabel("Links (%)", { exact: true }).fill("50");
  await audio.getByLabel("Rechts (%)", { exact: true }).fill("25");
  await audio.getByRole("checkbox", { name: "Im Broadcast stummschalten" }).check();
  await confirm(page, () => audio.locator("#native-audio-apply").press("Enter"), false);
  assert.equal(applyCount(), 0, "cancelled confirmation cannot send a mutation");
  await confirm(page, () => audio.locator("#native-audio-apply").press("Enter"));
  await audio.locator("#native-audio-status", { hasText: "neu abfragen" }).waitFor();
  const applied = await query();
  assert.equal(applied.audioRevision, initial.audioRevision + 1);
  assert.deepEqual(applied.sources, [{ ...initial.sources[0], leftGainQ15: 16384, rightGainQ15: 8192, muted: true }]);
  assert.equal(await audio.getByLabel("Links (%)", { exact: true }).inputValue(), "50");
  assert.equal(await audio.getByLabel("Rechts (%)", { exact: true }).inputValue(), "25");
  assert.equal(await audio.getByRole("checkbox", { name: "Im Broadcast stummschalten" }).isChecked(), true);
  assert.equal(applyCount(), 1);
  stage = "muted-output";
  audioOutput.muted = await measure("muted");
  assert.equal(await page.locator("#toggle-microphone").getAttribute("aria-pressed"), "true");
  stage = "unmute";
  await query();
  await audio.getByRole("checkbox", { name: "Im Broadcast stummschalten" }).uncheck();
  await confirm(page, () => audio.locator("#native-audio-apply").press("Enter"));
  await audio.locator("#native-audio-status", { hasText: "neu abfragen" }).waitFor();
  assert.equal((await query()).sources[0].muted, false);
  stage = "scaled-output";
  audioOutput.scaled = await measure("scaled", audioOutput.initial);
  }
  const revoke = async source => {
    await Promise.all([
      once(nativeEvents, "output-ready", { signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]) }),
      source.getByRole("button", { name: "Broadcast-Quelle sofort stoppen", exact: true }).click(),
    ]);
    for (let i = 0; i < 2; i++) {
      const response = await page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/native-handoff-control"), { timeout: 5000 });
      assert.equal(response.status(), 200);
    }
    await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor();
  };
  if (strategies) {
    const screen = await nativeAudioStrategyFlow({ page, audio, sources, query, confirm, viewer, strategies,
      stage: value => { stage = value; }, output: audioOutput });
    stage = "revoke-screen-audio";
    await revoke(screen);
    const retained = await query();
    assert.equal(retained.sources.length, 1); assert.equal(retained.sources[0].sourceKind, "microphone");
    assert.equal(retained.mix.strategy, strategies.at(-1));
    assert.equal(await page.locator("#toggle-screen").getAttribute("aria-pressed"), "true", "broadcast audio revoke preserves room screen capture");
  }
  stage = "revoke";
  // Revocation rotates the program output. A query during that transition is
  // correctly denied; wait for native readiness and fresh UI writer observations.
  await revoke(sources.locator("li", { hasText: "Sender aktiv" }));
  assert.deepEqual((await query()).sources, []);
  assert.equal(await audio.locator("#native-audio-apply").isDisabled(), false);
  assert.equal(await page.locator("#toggle-microphone").getAttribute("aria-pressed"), "true", "broadcast revoke does not stop room microphone");
  assert.equal(await page.evaluate(() => window.__sceneCaptures), strategies ? 2 : 1);
  assert.equal(f.app.registry.participantCount, 1);
  stage = "revoked-output";
  audioOutput.revoked = await measure("muted");
  assert.equal(await viewer.evaluate(() => window.__sceneCaptures), 0);
  await stopNativeAudioProbe(viewer); await viewer.close();
  stage = "program-stop";
  await page.locator("#native-source-stop").click();
  await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15_000 });
  await audio.waitFor({ state: "detached" });
});
