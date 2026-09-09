import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";
import { decodedAvatar, decodedGreenScreen, startAvatarCompanions } from "./helpers/machine-avatar-coexistence.mjs";
import { openTestVideoAvatar, syntheticAvatarVideo } from "./helpers/machine-avatar-video.mjs";
import { observeAvatarCommand } from "./helpers/machine-avatar-observation.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { machineSourceFailureObservation } from "./helpers/machine-source-failure-observation.mjs";

const PROFILE = "independent-owned-live-v1";
function checkSnapshot(value, peaks) {
  assert.deepEqual(Object.keys(value).sort(), ["epoch", "now_us", "profile", "schema", "sources", "timebase"]);
  assert.equal(value.schema, "ananta.meet-media-timing.v1"); assert.equal(value.profile, PROFILE);
  assert.equal(value.timebase, "browser-performance-v1"); assert.equal(value.epoch, 1);
  for (const [kind, row] of Object.entries(value.sources)) {
    assert.ok(["speech", "avatar", "screen"].includes(kind));
    assert.deepEqual(Object.keys(row).sort(), ["drift_us", "generation", "measurement", "observed_at_us", "origin_position_us",
      "position_at_us", "position_us", "started_at_us", "state"]);
    assert.ok(["running", "held"].includes(row.state), `${kind} quality must stay healthy`);
    assert.ok(value.now_us - row.observed_at_us <= 750_000);
    if (row.state === "running") assert.ok(value.now_us - row.position_at_us <= 750_000);
    if (kind === "screen") {
      assert.equal(row.measurement, "canvas-submission"); assert.equal(row.position_us, null); assert.equal(row.drift_us, null);
    } else {
      assert.equal(row.measurement, kind === "speech" ? "pcm-progress" : "decoded-video");
      assert.equal(row.drift_us, row.position_us - row.origin_position_us - (row.position_at_us - row.started_at_us));
      assert.ok(Math.abs(row.drift_us) <= 500_000); peaks[kind] = Math.max(peaks[kind] ?? 0, Math.abs(row.drift_us));
    }
  }
}

for (const engine of ["chromium", "firefox"]) {
test(`${engine} receives timed actual owned PCM/video/screen and bounded stale publication stop`, { timeout: 90000 }, async t => {
  const clip = syntheticAvatarVideo();
  const f = await machineBrowserFixture(t, { machineEngine: "chromium", humanEngine: engine });
  const { machine, human } = f, peaks = {};
  await human.evaluate(installDialogObservation);
  try {
    assert.deepEqual(await machine.evaluate(() => window.anantaMachine.timing.probe()), {
      schema: "ananta.meet-media-timing-probe.v1", profile: PROFILE, timebase: "browser-performance-v1",
      max_drift_us: 500_000, max_age_us: 750_000, decoded_video: true, canvas_submission: true,
    });
    assert.equal(await machine.evaluate(() => window.anantaMachine.status().joined), false);
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
      [f.roomId, await f.grant(["avatar.publish", "speech.publish", "screen.publish"])]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    const initial = await machine.evaluate(profile => window.anantaMachine.timing.start(profile), PROFILE);
    checkSnapshot(initial, peaks); assert.deepEqual(initial.sources, {});
    const sourceId = "avatar:" + f.binding.sessionId;
    const first = await machine.evaluate(openTestVideoAvatar, { sourceId, video: clip });
    assert.deepEqual(await observeAvatarCommand("avatar_video", human), { moving_avatar_video: true });
    await machine.evaluate(startAvatarCompanions, f.binding.sessionId);
    await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
    await waitFixtureValue(human, decodedGreenScreen);
    const until = performance.now() + 3000; let samples = 0, lastVideo = 0;
    while (performance.now() < until) {
      const snapshot = await machine.evaluate(() => window.anantaMachine.timing.snapshot());
      checkSnapshot(snapshot, peaks); assert.deepEqual(Object.keys(snapshot.sources).sort(), ["avatar", "screen", "speech"]);
      assert.ok(snapshot.sources.avatar.position_us >= lastVideo); lastVideo = snapshot.sources.avatar.position_us;
      samples++; await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(samples >= 10); assert.ok(lastVideo > 2_000_000, "actual observed video crosses multiple clip loops");
    await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), first.generation);
    await machine.evaluate(openTestVideoAvatar, { sourceId, video: { ...clip, repeatMode: "hold_last" } });
    await waitFixtureValue(machine, () => window.anantaMachine.timing.snapshot().sources.avatar?.state === "held");
    const held = await machine.evaluate(() => window.anantaMachine.timing.snapshot()); checkSnapshot(held, peaks);
    assert.equal(held.sources.avatar.generation, 2);
    const holdUntil = performance.now() + 1000;
    while (performance.now() < holdUntil) {
      const snapshot = await machine.evaluate(() => window.anantaMachine.timing.snapshot()); checkSnapshot(snapshot, peaks);
      assert.equal(snapshot.sources.avatar.position_at_us, held.sources.avatar.position_at_us);
      assert.equal(snapshot.sources.avatar.position_us, held.sources.avatar.position_us);
      const pixels = await human.evaluate(decodedAvatar);
      assert.ok(pixels?.center[2] > 170 && pixels.center[0] < 70, "receiver retains the real blue final frame");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await machine.evaluate(() => window.__avatarCompanions.close());
    // One deliberately unrefreshed synthetic screen. Native quality watchdog,
    // not a test-side close or relaxed source lease, must end its publication.
    const started = performance.now();
    await machine.evaluate(async sessionId => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const drawing = canvas.getContext("2d"); drawing.fillStyle = "#14dc14"; drawing.fillRect(0, 0, 640, 360);
      const jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
      const receipt = window.anantaMachine.screen.open("screen:" + sessionId);
      await window.anantaMachine.screen.push(receipt.generation, 1, jpeg);
    }, f.binding.sessionId);
    await waitFixtureValue(machine, () => window.anantaMachine.timing.snapshot().sources.screen?.state === "failed", null, { timeout: 1500 });
    const stoppedMs = performance.now() - started; assert.ok(stoppedMs < 1500);
    await waitFixtureValue(human, () => !document.querySelector('#media-grid .remote-media[data-source="screen"]'), null, { timeout: 2000 });
    assert.equal(await machine.evaluate(() => window.anantaMachine.timing.snapshot().sources.avatar.state), "held");
    await machine.evaluate(() => window.anantaMachine.screen.close());
    assert.equal(await machine.evaluate(() => window.anantaMachine.timing.snapshot().sources.screen.state), "failed");
    for (const page of [machine, human]) {
      assert.deepEqual(await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors })), { captures: 0, errors: [] });
    }
    t.diagnostic(JSON.stringify({ syntheticPolicy: true, productionEvidence: false, sourceClockOnly: true,
      actualCrossBrowserDecode: true, samples, peakDriftUs: peaks, staleScreenStopMs: stoppedMs }));
  } catch (error) {
    if (!machine.isClosed()) t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false,
      phase: "owned-source-timing", ...await machine.evaluate(machineSourceFailureObservation).catch(() => ({ unavailable: true })) }));
    throw error;
  } finally {
    if (!machine.isClosed()) await machine.evaluate(async () => {
      window.__avatarTestPulse?.stop(); await window.__avatarCompanions?.close(); window.anantaMachine.leave();
    });
    if (!human.isClosed()) await human.evaluate(() => window.__dialogObservation?.close());
  }
});
}

test("unsupported Firefox canvas publisher is reported without opening sources or falling back", { timeout: 30000 }, async t => {
  const f = await machineBrowserFixture(t, { machineEngine: "firefox" });
  const { machine } = f;
  const probe = await machine.evaluate(() => window.anantaMachine.timing.probe());
  assert.equal(probe.decoded_video, true); assert.equal(probe.canvas_submission, false);
  await assert.rejects(machine.evaluate(profile => window.anantaMachine.timing.start(profile), PROFILE), /meet_media_timing_canvas_unsupported/);
  assert.deepEqual(await machine.evaluate(() => ({ captures: window.__captures, joined: window.anantaMachine.status().joined,
    avatar: window.anantaMachine.avatar.status().state, speech: window.anantaMachine.speech.status().state,
    screen: window.anantaMachine.screen.status().open })), { captures: 0, joined: false, avatar: "closed", speech: "closed", screen: false });
});
