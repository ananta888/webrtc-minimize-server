import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { openSceneViewer, sceneViewerObservation } from "./helpers/native-scene-viewer.mjs";
import { confirm, outputAudio, publishOwnMicrophone, resources } from "./helpers/native-source-own-microphone.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, budgetMs, failure) {
  const started = performance.now();
  do {
    const value = await predicate();
    if (value) return { value, elapsedMs: Math.round(performance.now() - started) };
    await sleep(200);
  } while (performance.now() - started < budgetMs);
  assert.fail(failure);
}
/** Linux-only: encoders run with their stage directory as cwd. No process names or arguments are retained. */
async function encodersInside(directory) {
  let count = 0;
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try { if ((await fs.readlink(`/proc/${entry}/cwd`)).startsWith(directory + path.sep)) count++; } catch { /* exited or foreign */ }
  }
  return count;
}
async function packagerOnline(page, id, online) {
  await waitFixtureValue(page, async ({ id, online }) => {
    const r = await fetch("/api/native-packagers", { headers: { authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
    const row = (await r.json()).packagers?.find(p => p.id === id);
    return online ? row?.online === true && row.capability?.capabilityVersion === 6 : row?.online !== true;
  }, { id, online }, { timeout: 20000 });
}
async function startProgram(f) {
  const { page } = f;
  await page.locator("#mesh-analysis-navigation").press("Enter");
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator("#broadcast-navigation").press("Enter"); await page.locator("#native-source-program-open").press("Enter");
  await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
  await page.locator("#native-source-packager").selectOption(f.packagerId);
  await page.locator("#native-source-audio-preset").selectOption("speech");
  await confirm(page, () => page.locator("#native-source-start").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15000 });
  const running = (await f.request("GET", "/api/native-packagers")).body.assignments.filter(a => a.state === "running");
  assert.equal(running.length, 1);
  return running[0];
}

// Chaos on the real native path, complementing the deterministic domain
// coordinator: the active packager and then the origin are SIGKILLed while a
// consented program is playing. No retry, deadline or fence is relaxed.
test("killed packager and origin are fenced, reclaimed and recovered without a second publication", { timeout: 180000 }, async t => {
  if (process.platform !== "linux") { t.skip("Actual native processes require Linux containment and local FFmpeg"); return; }
  const f = await nativeSceneLiveFixture(t, { allowSyntheticAudio: true }), { page } = f;
  page.setDefaultTimeout(5000);
  const evidence = { synthetic: true, productionEvidence: false, phases: {} };
  let verified = false;
  t.after(() => t.diagnostic(JSON.stringify({ ...evidence, verified, observation: verified ? undefined : f.observation })));
  await packagerOnline(page, f.packagerId, true);
  assert.equal((await f.request("PUT", `/api/native-packagers/${f.packagerId}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
  const first = await startProgram(f);
  await page.locator("#toggle-microphone").click(); await publishOwnMicrophone(page);
  await outputAudio(f.output, true);
  const [oldResource] = await resources(f.output);
  assert.ok(oldResource);
  const oldDirectory = path.join(f.output, oldResource);
  const viewer = await openSceneViewer(f);
  await until(async () => (await sceneViewerObservation(viewer)).lifecycle === "playing", 20000, "viewer must play before chaos");
  assert.ok(await encodersInside(oldDirectory) >= 1, "the real encoder works inside the owned output");

  // Phase 1: abrupt packager loss. The control plane must stop visibly, the
  // orphaned encoder must end on its own and nothing may keep publishing.
  const killedAt = performance.now();
  await f.agent.crash();
  const failed = await until(async () => {
    const rows = (await f.request("GET", "/api/native-packagers")).body.assignments;
    const row = rows.find(a => a.assignmentId === first.assignmentId);
    return row?.state === "failed" && row.reasonCode === "CONTROL_DISCONNECTED" ? row : null;
  }, 15000, "control plane must fail the assignment after its socket closed");
  const program = await until(async () => {
    const row = (await f.request("GET", "/api/broadcasts/mine")).body.owned.find(p => p.programId === first.programId);
    return row?.availability === "ended" ? row : null;
  }, 15000, "program must reach a visible stop");
  await page.locator("#native-source-status", { hasText: /Sendung fehlgeschlagen|Sendung gestoppt/ }).waitFor({ timeout: 15000 });
  const uiFailedMs = Math.round(performance.now() - killedAt);
  const encoderGone = await until(async () => await encodersInside(oldDirectory) === 0, 30000, "orphaned encoder must exit after its parent died");
  const viewerAfter = await until(async () => {
    const before = await sceneViewerObservation(viewer); await sleep(2500); const after = await sceneViewerObservation(viewer);
    return after.lifecycle !== "playing" || after.playerErrorCode || after.time <= before.time ? { before, after } : null;
  }, 40000, "viewer must not keep advancing on a stopped program");
  await packagerOnline(page, f.packagerId, false);
  const runningAfterKill = (await f.request("GET", "/api/native-packagers")).body.assignments.filter(a => a.state === "running");
  assert.deepEqual(runningAfterKill, [], "no writer may remain active for the dead packager");
  evidence.phases.packagerCrash = { assignmentFailedMs: failed.elapsedMs, programAvailability: program.value.availability,
    uiFailedMs, encoderExitMs: encoderGone.elapsedMs, viewer: { lifecycle: viewerAfter.value.after.lifecycle,
      errorCode: viewerAfter.value.after.playerErrorCode, stalled: viewerAfter.value.after.time <= viewerAfter.value.before.time } };

  // Phase 2: same packager identity returns. Startup reclaims only its own dead
  // output; a fresh program publishes exactly once on a new resource.
  const restartedAt = performance.now();
  f.restartAgent();
  const reconnect = { socketMs: null, capabilityMs: null };
  await until(async () => {
    const row = (await f.request("GET", "/api/native-packagers")).body.packagers.find(p => p.id === f.packagerId);
    if (row?.online === true) reconnect.socketMs ??= Math.round(performance.now() - restartedAt);
    if (row?.online === true && row.capability?.capabilityVersion === 6) reconnect.capabilityMs ??= Math.round(performance.now() - restartedAt);
    return reconnect.capabilityMs !== null;
  }, 30000, "restarted packager must authenticate and report capability");
  const reclaimed = await until(async () => !(await resources(f.output)).includes(oldResource), 20000, "restarted packager must reclaim its orphaned output");
  await page.locator("#native-source-program-open").press("Enter").catch(() => {});
  const second = await startProgram(f);
  assert.notEqual(second.programId, first.programId); assert.notEqual(second.assignmentId, first.assignmentId);
  await publishOwnMicrophone(page);
  await outputAudio(f.output, true);
  const [newResource] = await resources(f.output);
  assert.notEqual(newResource, oldResource); assert.equal((await resources(f.output)).length, 1, "exactly one publication after recovery");
  evidence.phases.packagerRestart = { ...reconnect, reclaimedMs: reclaimed.elapsedMs, newEpochProgram: true };

  // Phase 3: origin loss. The writer keeps its fenced program; delivery fails
  // closed until the same origin address returns, then a fresh viewer plays.
  await viewer.close();
  const viewerBeforeOrigin = await openSceneViewer(f);
  await until(async () => (await sceneViewerObservation(viewerBeforeOrigin)).lifecycle === "playing", 20000, "second program must play");
  await viewerBeforeOrigin.close();
  await f.gateway.crash();
  const stillRunning = (await f.request("GET", "/api/native-packagers")).body.assignments.filter(a => a.state === "running");
  assert.equal(stillRunning.length, 1); assert.equal(stillRunning[0].assignmentId, second.assignmentId, "origin loss is not a writer loss");
  const denied = await openSceneViewer(f);
  const deniedState = await until(async () => {
    const o = await sceneViewerObservation(denied); return o.lifecycle !== "playing" && o.lifecycle !== "loading" && o.lifecycle !== "idle" || o.playerErrorCode ? o : null;
  }, 30000, "viewer must not report playback without an origin");
  assert.notEqual(deniedState.value.lifecycle, "playing");
  await denied.close();
  const gatewayRestartedAt = performance.now();
  f.restartGateway();
  const recovered = await openSceneViewer(f);
  const playing = await until(async () => (await sceneViewerObservation(recovered)).lifecycle === "playing", 30000, "fresh viewer must play after the origin returned");
  evidence.phases.originCrash = { deniedLifecycle: deniedState.value.lifecycle, deniedCode: deniedState.value.playerErrorCode,
    viewerRecoveredMs: Math.round(performance.now() - gatewayRestartedAt), playingMs: playing.elapsedMs };
  await recovered.close();
  assert.equal((await f.request("GET", "/api/native-packagers")).body.assignments.filter(a => a.state === "running").length, 1);

  await page.locator("#native-source-stop").press("Enter");
  await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15000 });
  await until(async () => (await resources(f.output)).length === 0, 15000, "stop must remove the live output");
  assert.equal(f.agent.alive(), true); assert.equal(f.gateway.alive(), true);
  await page.locator("#toggle-microphone").click();
  verified = true;
});
