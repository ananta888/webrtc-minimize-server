import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { retiredMachineAvatar } from "./helpers/machine-lifecycle-observation.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { openTestImageAvatar, syntheticAvatarImage } from "./helpers/machine-avatar-image.mjs";
import { startAvatarCompanions } from "./helpers/machine-avatar-coexistence.mjs";
import { installMultiPublisherObservation } from "./helpers/machine-multi-publisher-observation.mjs";

const isColor = (pixel, channel) => pixel?.[channel] > 150 && pixel.every((v, i) => i === channel || v < 80);
for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} isolates two machine personas, simultaneous speech/screens and individual departure`, { timeout: 60000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine });
    const second = await f.additionalMachine(), machines = [f, second], { human } = f;
    assert.notEqual(f.machine.context(), second.machine.context());
    for (const key of ["taskId", "runtimeId", "sessionId"]) assert.notEqual(f.binding[key], second.binding[key]);
    await assert.rejects(f.additionalMachine(), /test_machine_fixture_capacity/);
    await human.evaluate(installMultiPublisherObservation);
    try {
      const caps = ["avatar.publish", "screen.publish", "speech.publish"];
      const members = [];
      for (const item of machines) {
        const before = new Set(f.app.registry.members(f.roomId).map(peer => peer.id));
        await item.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await item.grant(caps)]);
        const added = f.app.registry.members(f.roomId).filter(peer => peer.machine && !before.has(peer.id));
        assert.equal(added.length, 1); members.push(added[0]);
      }
      await human.locator("#participant-count", { hasText: "3 / 20" }).waitFor();
      const peers = members.map(peer => peer.id);
      assert.notEqual(peers[0], peers[1]);
      assert.notEqual(members[0].principal, members[1].principal);
      assert.notEqual(members[0].deviceFingerprint, members[1].deviceFingerprint);
      for (const [index, item] of machines.entries()) {
        const denied = await item.machine.evaluate(async foreign => {
          const outcomes = [];
          for (const [kind, args] of [["screen", []], ["speech", [22050]], ["avatar", ["neutral-ai-v1"]]]) {
            try { await window.anantaMachine[kind].open(kind + ":" + foreign, ...args); outcomes.push("accepted"); }
            catch (error) { outcomes.push(error.message); }
          }
          return outcomes;
        }, machines[1 - index].binding.sessionId);
        assert.deepEqual(denied, ["meet_screen_source_denied", "meet_speech_source_denied", "meet_avatar_source_denied"]);
        await item.machine.evaluate(openTestImageAvatar, { sourceId: "avatar:" + item.binding.sessionId,
          image: syntheticAvatarImage(index === 0 ? [220, 20, 20] : [20, 20, 220]) });
        await item.machine.evaluate(startAvatarCompanions, { sessionId: item.binding.sessionId,
          screenColor: index === 0 ? "red" : "green" });
      }
      const both = await waitFixtureValue(human, ids => window.__multiPublisher.snapshot(ids), peers,
        { timeout: 10000, accept: v => !v.failed && v.publishers.every((p, i) =>
          isColor(p.camera, i === 0 ? 0 : 2) && isColor(p.screen, i) && p.audioTracks === 1 && p.active > 10 && p.peak > .1) });
      await waitFixtureValue(human, ids => window.__multiPublisher.active(ids), peers,
        { timeout: 5000, accept: active => active.every(Boolean) });
      for (const item of machines) assert.equal(await item.machine.evaluate(() => window.__avatarCompanions.failed), false);
      await f.machine.evaluate(async () => {
        window.__avatarTestPulse.stop(); await window.__avatarCompanions.close(); window.anantaMachine.leave();
      });
      await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
      // Membership changes fence old sources; the surviving controller obtains
      // fresh local source generations under its still-current session.
      await second.machine.evaluate(async () => { window.__avatarTestPulse.stop(); await window.__avatarCompanions.close(); });
      await waitFixtureValue(second.machine, retiredMachineAvatar, 2, { timeout: 2000 });
      await second.machine.evaluate(openTestImageAvatar, { sourceId: "avatar:" + second.binding.sessionId,
        image: syntheticAvatarImage([20, 20, 220]) });
      await second.machine.evaluate(startAvatarCompanions, { sessionId: second.binding.sessionId, screenColor: "green" });
      await human.evaluate(() => window.__multiPublisher.reset());
      const survivor = await waitFixtureValue(human, ids => window.__multiPublisher.snapshot(ids), peers,
        { timeout: 8000, accept: v => !v.failed && v.publishers[0].camera === null && v.publishers[0].screen === null
          && isColor(v.publishers[1].camera, 2) && isColor(v.publishers[1].screen, 1) && v.publishers[1].active > 10 });
      assert.equal((await human.evaluate(ids => window.__multiPublisher.active(ids), peers))[0], false);
      for (const page of [human, f.machine, second.machine]) {
        assert.deepEqual(await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors })),
          { captures: 0, errors: [] });
      }
      t.diagnostic(JSON.stringify({ syntheticPolicy: true, syntheticMedia: true, productionEvidence: false,
        singleHost: true, browserContexts: 3, both, survivor }));
    } finally {
      for (const item of machines) if (!item.machine.isClosed()) await item.machine.evaluate(async () => {
        window.__avatarTestPulse?.stop(); await window.__avatarCompanions?.close(); window.anantaMachine.leave();
      });
      if (!human.isClosed()) await human.evaluate(() => window.__multiPublisher?.close());
    }
  });
}
