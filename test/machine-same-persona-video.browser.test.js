import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { openTestImageAvatar, syntheticAvatarImage } from "./helpers/machine-avatar-image.mjs";
import { openTestVideoAvatar, syntheticAvatarVideo } from "./helpers/machine-avatar-video.mjs";
import { startAvatarCompanions } from "./helpers/machine-avatar-coexistence.mjs";
import { installMultiPublisherObservation } from "./helpers/machine-multi-publisher-observation.mjs";

const color = (pixel, channel) => pixel?.[channel] > 150 && pixel.every((v, i) => i === channel || v < 80);

async function observe(human, peers, firstMode) {
  const colors = [0, 0];
  const value = await waitFixtureValue(human, ids => window.__multiPublisher.snapshot(ids), peers, {
    timeout: 10000,
    accept: snapshot => !snapshot.failed && snapshot.publishers.every((row, index) => {
      const camera = firstMode === "video" || index === 1
        ? ((colors[index] |= color(row.camera, 0) ? 1 : color(row.camera, 2) ? 2 : 0) === 3)
        : firstMode === "image" ? color(row.camera, 1) : row.camera === null;
      return camera && color(row.screen, index) && row.audioTracks === 1 && row.active > 10;
    }),
  });
  // The accumulated peak is not proof of overlapping speech. Check fresh PCM
  // from both exact peer connections in the same receiver callback as well.
  await waitFixtureValue(human, ids => window.__multiPublisher.active(ids), peers,
    { timeout: 3000, accept: active => active.every(Boolean) });
  return { colors, publishers: value.publishers };
}

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} isolates identical persona clips and first-source replacement/stop`, { timeout: 60000 }, async t => {
    const video = syntheticAvatarVideo();
    const f = await machineBrowserFixture(t, { humanEngine });
    const second = await f.additionalMachine(), machines = [f, second], peers = [];
    assert.notEqual(f.machine.context(), second.machine.context());
    for (const key of ["taskId", "runtimeId", "sessionId"]) assert.notEqual(f.binding[key], second.binding[key]);
    await f.human.evaluate(installMultiPublisherObservation);
    try {
      for (const item of machines) {
        const before = new Set(f.app.registry.members(f.roomId).map(peer => peer.id));
        await item.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
          [f.roomId, await item.grant(["avatar.publish", "screen.publish", "speech.publish"])]);
        const added = f.app.registry.members(f.roomId).filter(peer => peer.machine && !before.has(peer.id));
        assert.equal(added.length, 1); peers.push(added[0].id);
      }
      await f.human.locator("#participant-count", { hasText: "3 / 20" }).waitFor();
      for (const [index, item] of machines.entries()) {
        // Identical normalized bytes, separately cloned into each owned browser.
        await item.machine.evaluate(openTestVideoAvatar, { sourceId: "avatar:" + item.binding.sessionId, video });
        await item.machine.evaluate(startAvatarCompanions, { sessionId: item.binding.sessionId,
          screenColor: index === 0 ? "red" : "green" });
      }
      const both = await observe(f.human, peers, "video");
      const before = await second.machine.evaluate(() => window.anantaMachine.avatar.status());
      await f.machine.evaluate(() => {
        window.__avatarTestPulse.stop();
        window.anantaMachine.avatar.close(window.anantaMachine.avatar.status().generation);
      });
      await f.machine.evaluate(openTestImageAvatar,
        { sourceId: "avatar:" + f.binding.sessionId, image: syntheticAvatarImage([20, 220, 20]) });
      const replacement = await observe(f.human, peers, "image");
      await f.machine.evaluate(() => {
        window.__avatarTestPulse.stop();
        window.anantaMachine.avatar.close(window.anantaMachine.avatar.status().generation);
      });
      const stopped = await observe(f.human, peers, "absent");
      const after = await second.machine.evaluate(() => window.anantaMachine.avatar.status());
      assert.equal(after.generation, before.generation);
      assert.ok(after.frames > before.frames);
      assert.equal(after.state, "open");
      assert.equal(f.app.registry.members(f.roomId).length, 3);
      for (const page of [f.human, f.machine, second.machine]) {
        assert.deepEqual(await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors })),
          { captures: 0, errors: [] });
      }
      t.diagnostic(JSON.stringify({ syntheticPolicy: true, sameSyntheticClip: true, productionEvidence: false,
        browserContexts: 3, secondGenerationUnchanged: true, secondAdditionalFrames: after.frames - before.frames,
        both, replacement, stopped }));
    } finally {
      for (const item of machines) if (!item.machine.isClosed()) await item.machine.evaluate(async () => {
        window.__avatarTestPulse?.stop(); await window.__avatarCompanions?.close(); window.anantaMachine.leave();
      });
      if (!f.human.isClosed()) await f.human.evaluate(() => window.__multiPublisher?.close());
    }
  });
}
