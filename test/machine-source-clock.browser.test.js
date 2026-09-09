import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";
import { openTestAvatar, startAvatarCompanions, decodedGreenScreen } from "./helpers/machine-avatar-coexistence.mjs";

function sourceState() {
  const api = window.anantaMachine;
  return { speech: api.speech.status(), avatar: api.avatar.status(), screen: api.screen.status(),
    joined: api.status().joined, companionsFailed: window.__avatarCompanions.failed };
}
async function cameraFrames() {
  let frames = 0;
  for (const pc of window.__pcs) for (const row of (await pc.getStats()).values()) {
    if (row.type === "inbound-rtp" && row.kind === "video" && [64, 128, 256].includes(row.frameWidth)
      && row.frameHeight === row.frameWidth) frames += row.framesDecoded || 0;
  }
  return frames;
}

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} keeps decoded owned speech/avatar/screen through an in-lease wall-clock correction`,
    { timeout: 60_000 }, async t => {
      const f = await machineBrowserFixture(t, { humanEngine }), { machine, human } = f;
      // Install before Angular constructs its source ports: they retain the
      // Date.now function, so replacing it AFTER construction would not test it.
      await machine.addInitScript(() => {
        const original = Date.now; let offset = 0;
        Date.now = () => original() + offset;
        window.__correctSourceClock = () => { offset = 3000; };
        window.__restoreSourceClock = () => { offset = 0; };
      });
      await machine.reload();
      await waitFixtureValue(machine, () => Boolean(window.anantaMachine));
      await human.evaluate(installDialogObservation);
      try {
        await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
          [f.roomId, await f.grant(["speech.publish", "avatar.publish", "screen.publish"])]);
        await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
        await machine.evaluate(openTestAvatar, "avatar:" + f.binding.sessionId);
        await machine.evaluate(startAvatarCompanions, f.binding.sessionId);
        await waitFixtureValue(human, decodedGreenScreen);
        await waitFixtureValue(human, () => window.__dialogObservation.status().active_windows > 10);
        // This async Stats query is awaited directly, never used as a truthy
        // page.waitForFunction predicate. Only numeric decoder counts leave it.
        const beforeFrames = await waitFixtureValue(human, cameraFrames, undefined,
          { accept: value => Number.isSafeInteger(value) && value > 0 });
        const beforeAudio = await human.evaluate(() => window.__dialogObservation.status().active_windows);
        const before = await machine.evaluate(sourceState);
        const immediate = await machine.evaluate(() => {
          window.__correctSourceClock();
          const api = window.anantaMachine;
          return { speech: api.speech.status().state, avatar: api.avatar.status().state, screen: api.screen.status().open };
        });
        assert.deepEqual(immediate, { speech: "open", avatar: "open", screen: true });
        await waitFixtureValue(machine, previous => {
          const api = window.anantaMachine;
          return api.speech.status().playedSamples > previous.speech.playedSamples + 22050
            && api.avatar.status().frames > previous.avatar.frames + 3
            && api.screen.status().sequence > previous.screen.sequence + 3;
        }, before, { timeout: 5000 });
        assert.ok(await human.evaluate(cameraFrames) > beforeFrames);
        assert.ok(await human.evaluate(() => window.__dialogObservation.status().active_windows) > beforeAudio + 10);
        assert.equal(await human.evaluate(decodedGreenScreen), true);
        const after = await machine.evaluate(sourceState);
        assert.equal(after.joined, true); assert.equal(after.companionsFailed, false);
        for (const page of [human, machine]) assert.deepEqual(await page.evaluate(() => ({
          captures: window.__captures, errors: window.__transformErrors,
        })), { captures: 0, errors: [] });
        t.diagnostic("Private synthetic 3000-ms epoch correction; actual continuing decoded media, unchanged absolute leases and local interval budgets. No host clock change.");
      } finally {
        if (!machine.isClosed()) await machine.evaluate(async () => {
          window.__avatarTestPulse?.stop();
          try { await window.__avatarCompanions?.close(); }
          finally {
            window.anantaMachine.leave();
            window.__restoreSourceClock?.(); delete window.__restoreSourceClock;
          }
        });
      }
    });
}
