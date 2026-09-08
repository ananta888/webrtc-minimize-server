import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";
import { avatarAbsent, decodedAvatar, decodedGreenScreen, startAvatarCompanions } from "./helpers/machine-avatar-coexistence.mjs";
import { openTestImageAvatar, syntheticAvatarImage } from "./helpers/machine-avatar-image.mjs";
import { openTestVideoAvatar, syntheticAvatarVideo } from "./helpers/machine-avatar-video.mjs";
import { observeAvatarCommand } from "./helpers/machine-avatar-observation.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

for (const humanEngine of ["chromium", "firefox"]) {
test(`${humanEngine} receives actual silent avatar video, image replacement and independent source stop`, { timeout: 90000 }, async t => {
  const clip = syntheticAvatarVideo(), f = await machineBrowserFixture(t, { humanEngine }), { machine, human } = f;
  await human.evaluate(installDialogObservation);
  try {
    const beforeProbe = await machine.evaluate(() => ({ captures: window.__captures, peers: window.__pcs.length,
      avatar: window.anantaMachine.avatar.status(), joined: window.anantaMachine.status().joined }));
    assert.deepEqual(await machine.evaluate(() => window.anantaMachine.avatar.videoProbe()),
      { schema: "ananta.meet-avatar-video-probe.v1", profile: "persona-video-v1", mp4H264: true });
    assert.deepEqual(await machine.evaluate(() => ({ captures: window.__captures, peers: window.__pcs.length,
      avatar: window.anantaMachine.avatar.status(), joined: window.anantaMachine.status().joined })), beforeProbe,
    "feasibility observation must not join, capture, create a peer or start an avatar");
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
      [f.roomId, await f.grant(["avatar.publish", "speech.publish", "screen.publish"])]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    const sourceId = "avatar:" + f.binding.sessionId;
    const first = await machine.evaluate(openTestVideoAvatar, { sourceId, video: clip });
    assert.equal(first.profile, "persona-video-v1");
    assert.deepEqual(await observeAvatarCommand("avatar_video", human), { moving_avatar_video: true });
    await machine.evaluate(startAvatarCompanions, f.binding.sessionId);
    await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
    await waitFixtureValue(human, decodedGreenScreen);
    await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), first.generation);
    await machine.evaluate(() => window.__avatarTestPulse.stop());
    await waitFixtureValue(human, avatarAbsent);
    const second = await machine.evaluate(openTestImageAvatar, { sourceId, image: syntheticAvatarImage([20, 20, 220]) });
    assert.ok(second.generation > first.generation);
    assert.equal(await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), first.generation), false);
    assert.deepEqual(await observeAvatarCommand("avatar_image_blue", human), { moving_avatar_image: "blue" });
    await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), second.generation);
    await machine.evaluate(() => window.__avatarTestPulse.stop());
    await waitFixtureValue(human, avatarAbsent);
    const third = await machine.evaluate(openTestVideoAvatar, { sourceId, video: { ...clip, repeatMode: "hold_last" } });
    assert.ok(third.generation > second.generation);
    assert.deepEqual(await observeAvatarCommand("avatar_image_blue", human), { moving_avatar_image: "blue" });
    // Re-observe the held final clip frame through changing KI liveness pixels:
    // the source remains live, but the clip must not loop back to red.
    const framesBeforeHold = await machine.evaluate(() => window.anantaMachine.avatar.status().frames);
    const holdUntil = performance.now() + 1250; let heldSamples = 0;
    while (performance.now() < holdUntil) {
      const pixels = await human.evaluate(decodedAvatar);
      assert.ok(pixels?.center?.[2] > 170 && pixels.center[0] < 70 && pixels.center[1] < 70,
        "hold_last must retain blue across a complete possible loop, not return to red");
      heldSamples++; await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(heldSamples >= 4, "observe more than isolated endpoint snapshots");
    assert.ok(await machine.evaluate(() => window.anantaMachine.avatar.status().frames) > framesBeforeHold);
    await machine.evaluate(() => window.__avatarTestPulse.stop()); // No explicit source close: actual pulse loss.
    const stoppedAt = performance.now();
    await waitFixtureValue(human, avatarAbsent, null, { timeout: 4000 });
    const stopMs = performance.now() - stoppedAt;
    await waitFixtureValue(human, decodedGreenScreen);
    await human.evaluate(() => window.__dialogObservation.resetAudio());
    await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
    assert.equal(await machine.evaluate(() => window.__avatarCompanions.failed), false);
    await machine.evaluate(() => window.__avatarCompanions.close());
    await machine.evaluate(() => window.anantaMachine.leave());
    await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
    for (const page of [human, machine]) {
      const observed = await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors }));
      assert.equal(observed.captures, 0); assert.deepEqual(observed.errors, []);
    }
    t.diagnostic(JSON.stringify({ syntheticPolicy: true, syntheticClip: true, actualVideoDecode: true,
      productionEvidence: false, holdLast: true, heldSamples, generations: [first.generation, second.generation, third.generation], stopMs }));
  } finally {
    if (!human.isClosed()) await human.evaluate(() => window.__dialogObservation?.close());
    if (!machine.isClosed()) {
      await machine.evaluate(() => window.__avatarTestPulse?.stop());
      await machine.evaluate(() => window.__avatarCompanions?.close());
    }
  }
});
}
