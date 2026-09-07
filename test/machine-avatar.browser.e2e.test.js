import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";
import { avatarAbsent, decodedAvatar, decodedCompanionScreen, decodedGreenScreen, openTestAvatar, startAvatarCompanions } from "./helpers/machine-avatar-coexistence.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

for (const humanEngine of ["chromium", "firefox"]) {
test(`${humanEngine} decodes avatar, speech and screen across three lease renewals without capture`, { timeout: 90000 }, async t => {
  const f = await machineBrowserFixture(t, { humanEngine }), { human, machine } = f;
  assert.equal(human.context().browser().browserType().name(), humanEngine);
  // Override the fixture's optional human tone-capture path: this test permits no device API at all.
  await human.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { window.__captures++; throw new Error("capture_forbidden"); }; });
  await human.evaluate(installDialogObservation);
  const closeObservers = async () => {
    if (!human.isClosed()) await human.evaluate(() => window.__dialogObservation?.close());
    if (!machine.isClosed()) {
      t.diagnostic(JSON.stringify(await machine.evaluate(() => ({ avatar: window.anantaMachine.avatar.status(),
        e2ee: window.anantaMachine.status().e2ee, errors: window.__transformErrors, captures: window.__captures,
        companionsFailed: window.__avatarCompanions?.failed || false }))));
      await machine.evaluate(() => window.__avatarCompanions?.close());
      await machine.evaluate(() => window.__avatarTestPulse?.stop());
    }
  };
  try {
  const caps = ["avatar.publish", "speech.publish", "screen.publish"];
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  const sourceId = "avatar:" + f.binding.sessionId;
  const first = await machine.evaluate(openTestAvatar, sourceId);
  assert.equal(first.profile, "neutral-ai-v1");
  const image = await waitFixtureValue(human, decodedAvatar, null, { accept: v => Array.isArray(v?.center) && v.white > 100 });
  assert.ok(image.center[1] > 170 && image.center[0] > 60 && image.center[0] < 160, "remote decoded neutral face color");
  assert.ok(image.white > 100, "remote decoded visible white KI label glyphs");
  let changed = false;
  for (let i = 0; i < 12 && !changed; i++) {
    await human.waitForTimeout(150); const next = await human.evaluate(decodedAvatar);
    changed = Boolean(next && next.bright !== image.bright);
  }
  assert.equal(changed, true, "remote decoded moving source indicator, not a static placeholder");
  await machine.evaluate(startAvatarCompanions, f.binding.sessionId);
  await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
  await waitFixtureValue(human, decodedGreenScreen);
  await machine.waitForFunction(() => window.anantaMachine.avatar.status().state === "open", undefined, { timeout: 3000 });
  const simultaneous = await waitFixtureValue(human, decodedAvatar, null, { accept: v => v?.white > 100 });
  // Avatar-only stop must leave actual speech and screen source progress untouched.
  const before = await machine.evaluate(() => ({ samples: window.anantaMachine.speech.status().playedSamples, screen: window.anantaMachine.screen.status().sequence }));
  assert.equal(await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), first.generation), true);
  await machine.evaluate(() => window.__avatarTestPulse.stop());
  await human.evaluate(() => window.__dialogObservation.resetAudio());
  await waitFixtureValue(human, avatarAbsent);
  await machine.waitForFunction(prior => window.anantaMachine.speech.status().playedSamples > prior.samples + 2205
    && window.anantaMachine.screen.status().sequence > prior.screen, before);
  assert.equal(await machine.evaluate(() => window.__avatarCompanions.failed), false);
  await waitFixtureValue(human, decodedGreenScreen);
  const audio = await waitFixtureValue(human, () => window.__dialogObservation.status(), null,
    { accept: v => v?.active_windows > 10 });
  assert.equal(audio.failed, false); assert.ok(audio.peak > .1); assert.ok(audio.active_windows > 10);
  await machine.evaluate(() => window.__avatarCompanions.close());
  let active = await machine.evaluate(openTestAvatar, sourceId);
  const renewalEvidence = [];
  for (let renewal = 0; renewal < 3; renewal++) {
    const beforeLease = await machine.evaluate(() => window.anantaMachine.status().lease);
    // Real JWT seconds: the next grant must extend the lease, not only change its ID.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await machine.evaluate(() => window.__avatarTestPulse.stop());
    await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps));
    const afterLease = await machine.evaluate(() => window.anantaMachine.status().lease);
    assert.equal(afterLease.sessionId, beforeLease.sessionId);
    assert.equal(afterLease.generation, beforeLease.generation + 1);
    await waitFixtureValue(machine, () => window.anantaMachine.avatar.status().state === "failed");
    const fresh = await machine.evaluate(openTestAvatar, sourceId);
    assert.ok(fresh.generation > active.generation);
    assert.equal(await machine.evaluate(gen => window.anantaMachine.avatar.close(gen), active.generation), false);
    active = fresh;
    await human.evaluate(() => window.__dialogObservation.resetAudio());
    const screenColor = renewal % 2 === 0 ? "red" : "green";
    await machine.evaluate(startAvatarCompanions, { sessionId: f.binding.sessionId, screenColor });
    const indicators = new Set();
    await waitFixtureValue(human, decodedAvatar, null, { timeout: 6000, accept: value => {
      if (!value || value.white <= 100 || value.center[1] <= 170 || value.center[0] <= 60 || value.center[0] >= 160) return false;
      indicators.add(value.bright); return indicators.size >= 2;
    } });
    await waitFixtureValue(human, decodedCompanionScreen, screenColor);
    const renewedAudio = await waitFixtureValue(human, () => window.__dialogObservation.status(), null,
      { accept: value => value?.active_windows > 10 && value.peak > .1 && !value.failed });
    const connections = await machine.evaluate(() => window.__pcs.map(pc => ({
      slots: pc.getTransceivers().length, sdpBytes: pc.localDescription?.sdp.length || 0,
      signaling: pc.signalingState, connection: pc.connectionState,
    })));
    assert.equal(connections.length, 1, "same peer connection across all lease renewals");
    assert.equal(connections[0].slots, 3, "one reusable slot per avatar, screen and speech publication");
    assert.ok(connections[0].sdpBytes > 0 && connections[0].sdpBytes < 24000, "bounded three-source SDP");
    assert.equal(connections[0].signaling, "stable");
    assert.equal(connections[0].connection, "connected");
    assert.equal(await machine.evaluate(() => window.__avatarCompanions.failed), false);
    assert.equal(await machine.evaluate(() => window.anantaMachine.status().e2ee), "active");
    renewalEvidence.push({ renewal: renewal + 1, movingAvatar: true, decodedScreen: screenColor,
      audioWindows: renewedAudio.active_windows, slots: connections[0].slots });
    await machine.evaluate(() => window.__avatarCompanions.close());
  }
  // A dead controller must not leave an independently animated camera for 30 s.
  await machine.evaluate(() => window.__avatarTestPulse.stop());
  const lossAt = performance.now();
  await waitFixtureValue(machine, () => window.anantaMachine.avatar.status().state === "failed", null, { timeout: 3000 });
  const controllerStopMs = performance.now() - lossAt;
  await waitFixtureValue(human, avatarAbsent, null, { timeout: 1000 });
  await machine.evaluate(openTestAvatar, sourceId);
  await machine.evaluate(() => window.__avatarTestPulse.stop());
  await machine.evaluate(() => window.anantaMachine.leave());
  await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
  for (const page of [human, machine]) {
    const observed = await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors }));
    assert.equal(observed.captures, 0); assert.deepEqual(observed.errors, []);
  }
  t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, image, audioWindows: audio.active_windows,
    movingIndicator: changed, controllerStopMs, simultaneous, renewalEvidence }));
  } finally { await closeObservers(); }
});
}
