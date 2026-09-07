import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";
import { avatarAbsent, decodedAvatar, decodedGreenScreen, startAvatarCompanions } from "./helpers/machine-avatar-coexistence.mjs";
import { openTestImageAvatar, syntheticAvatarImage } from "./helpers/machine-avatar-image.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

for (const humanEngine of ["chromium", "firefox"]) {
test(`${humanEngine} decodes replacement persona PNG with fixed KI label beside independent audio and screen`, { timeout: 90000 }, async t => {
  const f = await machineBrowserFixture(t, { humanEngine }), { human, machine } = f;
  assert.equal(human.context().browser().browserType().name(), humanEngine);
  await human.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { window.__captures++; throw new Error("capture_forbidden"); }; });
  await human.evaluate(installDialogObservation);
  try {
    const caps = ["avatar.publish", "speech.publish", "screen.publish"];
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    const sourceId = "avatar:" + f.binding.sessionId, red = syntheticAvatarImage([220, 20, 20]), blue = syntheticAvatarImage([20, 20, 220]);
    const first = await machine.evaluate(openTestImageAvatar, { sourceId, image: red });
    assert.equal(first.profile, "persona-image-v1");
    const redFrame = await waitFixtureValue(human, decodedAvatar, null,
      { accept: v => v?.white > 100 && v.center[0] > 170 && v.center[2] < 80 });
    await machine.evaluate(startAvatarCompanions, f.binding.sessionId);
    await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
    await waitFixtureValue(human, decodedGreenScreen);
    // Explicit replacement removes old camera publication before any new image.
    assert.equal(await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), first.generation), true);
    await machine.evaluate(() => window.__avatarTestPulse.stop());
    await waitFixtureValue(human, avatarAbsent);
    const next = await machine.evaluate(openTestImageAvatar, { sourceId, image: blue });
    assert.ok(next.generation > first.generation);
    assert.equal(await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), first.generation), false);
    const blueFrame = await waitFixtureValue(human, decodedAvatar, null,
      { accept: v => v?.white > 100 && v.center[2] > 170 && v.center[0] < 80 });
    let moving = false;
    for (let i = 0; i < 12 && !moving; i++) {
      await human.waitForTimeout(150); const frame = await human.evaluate(decodedAvatar);
      assert.ok(frame && frame.center[2] > 170 && frame.center[0] < 80, "old image must not reappear");
      moving = frame.bright !== blueFrame.bright;
    }
    assert.equal(moving, true);
    await waitFixtureValue(human, decodedGreenScreen);
    await human.evaluate(() => window.__dialogObservation.resetAudio());
    await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
    // Corrupt bytes cannot become a neutral avatar or produce any camera track.
    await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), next.generation);
    await machine.evaluate(() => window.__avatarTestPulse.stop());
    await waitFixtureValue(human, avatarAbsent);
    const denial = await machine.evaluate(async ({ sourceId, image }) => {
      try { await window.anantaMachine.avatar.open(sourceId, "persona-image-v1", image); return "accepted"; }
      catch (error) { return error.message; }
    }, { sourceId, image: { ...red, sha256: "0".repeat(64) } });
    assert.equal(denial, "meet_avatar_image_digest_invalid");
    await waitFixtureValue(human, avatarAbsent);
    assert.equal(await machine.evaluate(() => window.__avatarCompanions.failed), false);
    await machine.evaluate(() => window.__avatarCompanions.close());
    await machine.evaluate(() => window.anantaMachine.leave());
    await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
    for (const page of [human, machine]) {
      const observed = await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors }));
      assert.equal(observed.captures, 0); assert.deepEqual(observed.errors, []);
    }
    t.diagnostic(JSON.stringify({ syntheticPolicy: true, syntheticImage: true, productionEvidence: false, redFrame, blueFrame, moving }));
  } finally {
    if (!human.isClosed()) await human.evaluate(() => window.__dialogObservation?.close());
    if (!machine.isClosed()) {
      await machine.evaluate(() => window.__avatarTestPulse?.stop());
      await machine.evaluate(() => window.__avatarCompanions?.close());
    }
  }
});
}
