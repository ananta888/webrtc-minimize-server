import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

// A closed diagnostic profile isolates source-count failures from wall-clock
// soaks. It does not extend any individual source or membership lease.
const profile = process.env.MEET_TEST_SCREEN_CHURN || "ordinary";
if (!["ordinary", "extended", "lease-churn"].includes(profile)) throw new Error("test_screen_churn_profile_invalid");
const activations = profile === "ordinary" ? 18 : 80;
const renewalInterval = profile === "lease-churn" ? 2 : 40;

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} receives ${activations} separately authorized screen activations without growing SDP or transceivers`,
    { timeout: profile === "ordinary" ? 90_000 : 150_000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine });
    await f.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(["screen.publish"])]);
    await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    const colors = await f.human.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      return ["#dd1414", "#14dd14"].map(color => {
        const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 640, 360);
        return canvas.toDataURL("image/jpeg", .7).split(",")[1];
      });
    });
    for (let activation = 0; activation < activations; activation++) {
      if (activation > 0 && activation % renewalInterval === 0) {
        await f.machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(["screen.publish"]));
      }
      const source = await f.machine.evaluate(id => window.anantaMachine.screen.open(id), "screen:" + f.binding.sessionId);
      for (let seq = 1; seq <= 5; seq++) {
        await f.machine.evaluate(([g, s, frame]) => window.anantaMachine.screen.push(g, s, frame),
          [source.generation, seq, colors[activation % 2]]);
        await new Promise(resolve => setTimeout(resolve, 230));
      }
      await f.human.waitForFunction(green => [...document.querySelectorAll("video")].some(video => {
        if (!video.videoWidth) return false;
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d"); ctx.drawImage(video, 0, 0, 1, 1);
        const [r, g] = ctx.getImageData(0, 0, 1, 1).data; return green ? g > 150 && r < 80 : r > 150 && g < 80;
      }), activation % 2 === 1, { timeout: 1500, polling: 50 });
      // Renegotiation may deliver the same receiver track again. Its old native
      // track ID must not create a second camera or replace the current decrypt context.
      await f.human.evaluate(() => {
        for (const pc of window.__pcs) for (const transceiver of pc.getTransceivers()) {
          const receiver = transceiver.receiver;
          if (receiver.track.kind === "video") pc.dispatchEvent(new RTCTrackEvent("track", {
            track: receiver.track, receiver, transceiver, streams: [new MediaStream([receiver.track])],
          }));
        }
      });
      assert.equal(await f.human.locator("video").count(), 1, "duplicate track event preserves one source");
      const state = await f.machine.evaluate(() => window.__pcs.map(pc => ({
        slots: pc.getTransceivers().length, sdpBytes: pc.localDescription?.sdp.length || 0, state: pc.signalingState,
      })));
      assert.ok(state.length > 0);
      for (const pc of state) {
        assert.equal(pc.slots, 1, `activation ${activation + 1}: exactly one reusable video slot`);
        assert.ok(pc.sdpBytes < 12_000, `activation ${activation + 1}: bounded SDP well below the unchanged 80k gate`);
        assert.equal(pc.state, "stable");
      }
      if ((activation + 1) % 10 === 0) t.diagnostic(JSON.stringify({ activations: activation + 1, engine: humanEngine }));
    }
    assert.equal(await f.machine.evaluate(() => window.__captures), 0);
    await f.machine.evaluate(() => window.anantaMachine.leave());
  });
}
