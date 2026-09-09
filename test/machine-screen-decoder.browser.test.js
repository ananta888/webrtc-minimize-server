import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { decodedGreenScreen } from "./helpers/machine-avatar-coexistence.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

// Delay delivery, not decoding or key exchange. The actual browser bitmap must
// be disposed after its owning source closes, before another source can open.
function holdScreenBitmap(sessionId) {
  const native = window.createImageBitmap.bind(window);
  const state = { started: 0, closed: 0, release: null, pending: null,
    restore() { window.createImageBitmap = native; } };
  window.__screenDecoderTest = state;
  window.createImageBitmap = async (...args) => {
    if (!(args[0] instanceof Blob) || args[0].type !== "image/jpeg") return native(...args);
    ++state.started;
    const bitmap = await native(...args), close = bitmap.close.bind(bitmap);
    bitmap.close = () => { ++state.closed; close(); };
    return new Promise(resolve => { state.release = () => { state.release = null; resolve(bitmap); }; });
  };
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const drawing = canvas.getContext("2d"); drawing.fillStyle = "rgb(220,20,220)";
  drawing.fillRect(0, 0, 640, 360);
  const jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
  const source = window.anantaMachine.screen, lease = source.open("screen:" + sessionId);
  state.pending = source.push(lease.generation, 1, jpeg).then(() => "unexpected_success", error => error.message);
}

function startFreshScreen(sessionId) {
  const state = { stopped: false, failed: false, timer: null, close() {
    this.stopped = true; clearTimeout(this.timer); window.anantaMachine.screen.close();
  } };
  window.__freshScreenTest = state;
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const drawing = canvas.getContext("2d"); drawing.fillStyle = "rgb(20,220,20)";
  drawing.fillRect(0, 0, 640, 360);
  const jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
  const source = window.anantaMachine.screen, lease = source.open("screen:" + sessionId);
  let sequence = 0;
  const tick = async () => {
    if (state.stopped || sequence >= 30) return;
    try {
      await source.push(lease.generation, ++sequence, jpeg);
      if (!state.stopped) state.timer = setTimeout(tick, 250);
    } catch { if (!state.stopped) state.failed = true; }
  };
  void tick();
}

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} fences late screen decoding and removes an ended synthetic track`, { timeout: 60000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine }), { machine, human } = f;
    try {
      await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(["screen.publish"])]);
      await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
      await machine.evaluate(holdScreenBitmap, f.binding.sessionId);
      await waitFixtureValue(machine, () => typeof window.__screenDecoderTest.release === "function");
      const held = await machine.evaluate(sessionId => {
        const source = window.anantaMachine.screen; source.close();
        let denied = 0;
        for (let i = 0; i < 8; i++) {
          try { source.open("screen:" + sessionId); }
          catch (error) { if (error.message !== "meet_screen_decoder_busy") throw error; ++denied; }
        }
        return { denied, open: source.status().open, started: window.__screenDecoderTest.started };
      }, f.binding.sessionId);
      assert.deepEqual(held, { denied: 8, open: false, started: 1 });
      const settled = await machine.evaluate(async () => {
        const state = window.__screenDecoderTest; state.release();
        const outcome = await state.pending; state.restore();
        return { outcome, closed: state.closed };
      });
      assert.ok(["meet_screen_authority_changed", "meet_screen_decode_timeout"].includes(settled.outcome));
      assert.equal(settled.closed, 1);
      await machine.evaluate(() => {
        const native = HTMLCanvasElement.prototype.captureStream;
        window.__screenTrackTest = { track: null, restore() { HTMLCanvasElement.prototype.captureStream = native; } };
        HTMLCanvasElement.prototype.captureStream = function (...args) {
          const stream = native.apply(this, args);
          if (this.width === 640 && this.height === 360 && args[0] === 0) {
            window.__screenTrackTest.track = stream.getVideoTracks()[0];
          }
          return stream;
        };
      });
      await machine.evaluate(startFreshScreen, f.binding.sessionId);
      await waitFixtureValue(human, decodedGreenScreen, null, { timeout: 7000 });
      assert.equal(await machine.evaluate(() => window.__freshScreenTest.failed), false);
      await machine.evaluate(() => {
        const state = window.__freshScreenTest;
        state.stopped = true; clearTimeout(state.timer);
        const track = window.__screenTrackTest.track;
        if (!track || track.readyState !== "live") throw new Error("test_screen_track_missing");
        // A real native track stop, not screen.close(), Leave or lease expiry.
        track.stop();
      });
      await waitFixtureValue(machine, () => !window.anantaMachine.screen.status().open, null, { timeout: 1000 });
      await waitFixtureValue(human, () => !document.querySelector('#media-grid .remote-media[data-source="screen"]'),
        null, { timeout: 2000 });
      assert.equal(await machine.evaluate(() => window.anantaMachine.status().joined), true);
      await machine.evaluate(startFreshScreen, f.binding.sessionId);
      await waitFixtureValue(human, decodedGreenScreen, null, { timeout: 7000 });
      assert.equal(await machine.evaluate(() => window.__freshScreenTest.failed), false);
      await machine.evaluate(() => { window.__freshScreenTest.close(); window.anantaMachine.leave(); });
      await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
      for (const page of [machine, human]) {
        assert.deepEqual(await page.evaluate(() => ({ captures: window.__captures, errors: window.__transformErrors })),
          { captures: 0, errors: [] });
      }
      t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, ...held,
        disposedBitmaps: settled.closed, freshGreenScreenDecoded: true,
        nativeTrackEndRemovedScreen: true, explicitRestartDecoded: true }));
    } finally {
      if (!machine.isClosed()) await machine.evaluate(() => {
        window.__freshScreenTest?.close(); window.__screenDecoderTest?.release?.();
        window.__screenDecoderTest?.restore(); window.__screenTrackTest?.restore(); window.anantaMachine.leave();
      });
    }
  });
}
