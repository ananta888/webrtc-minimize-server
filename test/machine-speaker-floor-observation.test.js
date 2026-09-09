import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installSpeakerFloorObservation } from "./helpers/machine-speaker-floor-observation.mjs";

function fixture() {
  const peers = ["a".repeat(16), "b".repeat(16)];
  let now = 0, callback = null, closes = 0;
  const audio = peers.map(() => ({ kind: "audio", readyState: "live", level: 0 }));
  const video = peers.map(() => ({ kind: "video", readyState: "live" }));
  const receivers = peers.map((_, i) => [{ track: video[i] }, { track: audio[i] }]);
  const pcs = peers.map((_, i) => ({ connectionState: "connected", getReceivers: () => receivers[i] }));
  let elements = peers.map((peer, i) => ({ dataset: { peerId: peer }, querySelector: () => ({
    readyState: 2, videoWidth: 640, srcObject: { getVideoTracks: () => [video[i]] },
  }) }));
  class AudioContext {
    state = "suspended";
    destination = {};
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaStreamSource(stream) { return { connect(analyser) { analyser.track = stream.tracks[0]; }, disconnect() {} }; }
    createAnalyser() { return { fftSize: 8, connect() {}, disconnect() {},
      getFloatTimeDomainData(pcm) { pcm.fill(this.track.level); } }; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; closes++; }
  }
  const window = { __pcs: pcs };
  const globals = { window, document: { querySelectorAll: () => elements }, peers, AudioContext,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    performance: { now: () => now, timeOrigin: 1700000000000 },
    setInterval(fn, delay) { assert.equal(delay, 20); callback = fn; return 1; },
    clearInterval() { callback = null; },
  };
  return { peers, audio, pcs, receivers, window, globals,
    install: () => vm.runInNewContext(`(${installSpeakerFloorObservation.toString()})(peers)`, globals),
    tick(ms = 20) { now += ms; callback?.(); },
    hideVideos() { elements = []; },
    snapshot: () => JSON.parse(JSON.stringify(window.__speakerFloor.snapshot())),
    get closed() { return closes; }, get sampling() { return callback !== null; },
  };
}

test("successive audio does not become historical overlap through UI navigation", async () => {
  const f = fixture(); await f.install(); f.hideVideos();
  f.audio[0].level = .1; for (let i = 0; i < 3; i++) f.tick();
  f.audio[0].level = 0; f.tick();
  f.audio[1].level = .1; for (let i = 0; i < 3; i++) f.tick();
  const state = f.snapshot();
  assert.deepEqual(state.counts, [3, 3]); assert.equal(state.overlap, 0); assert.equal(state.failed, false);
  assert.ok(state.last_at_ms[0] < state.first_at_ms[1]); assert.equal(state.max_gap_ms, 20);
  assert.ok(!JSON.stringify(state).includes(f.peers[0]));
  state.counts[0] = 999; assert.equal(f.snapshot().counts[0], 3);
  f.audio[1].level = 0; for (let i = 0; i < 15; i++) f.tick();
  assert.equal(f.snapshot().quiet_ms, 300);
  await f.window.__speakerFloor.close(); assert.equal(f.closed, 1); assert.equal(f.sampling, false);
  await f.window.__speakerFloor.close(); assert.equal(f.closed, 1);
});

test("actual same-callback non-silent sources increment overlap immediately", async () => {
  const f = fixture(); await f.install();
  f.audio.forEach(track => { track.level = .1; }); f.tick();
  assert.equal(f.snapshot().overlap, 1); assert.deepEqual(f.snapshot().active, [true, true]);
  await f.window.__speakerFloor.close();
});

test("missing decoded-video binding is not silently treated as a silent peer", async () => {
  const f = fixture(); f.hideVideos();
  await assert.rejects(f.install(), /connection_invalid/); assert.equal(f.closed, 0);
});

for (const peers of [["a".repeat(16), "a".repeat(16)], [], ["bad", "b".repeat(16)], [1, 2]]) {
  test(`invalid peer scope is rejected before audio setup: ${JSON.stringify(peers)}`, async () => {
    const f = fixture(); f.globals.peers = peers;
    await assert.rejects(f.install(), /binding_invalid/); assert.equal(f.sampling, false);
  });
}

test("duplicate installation cannot replace an existing observation", async () => {
  const f = fixture(); await f.install(); const first = f.window.__speakerFloor;
  await assert.rejects(f.install(), /binding_invalid/); assert.equal(f.window.__speakerFloor, first);
  await first.close();
});

for (const failure of ["disconnected", "blind-gap", "track-budget", "observation-deadline"]) {
  test(`observation fails closed on ${failure}`, async () => {
    const f = fixture(); await f.install();
    if (failure === "disconnected") f.pcs[0].connectionState = "disconnected";
    if (failure === "track-budget") for (let i = 0; i < 9; i++) f.receivers[0].push({
      track: { kind: "audio", readyState: "live", level: 0 },
    });
    if (failure === "observation-deadline") for (let i = 0; i < 3000; i++) f.tick();
    else f.tick(failure === "blind-gap" ? 251 : 20);
    assert.equal(f.snapshot().failed, true); assert.equal(f.sampling, false);
    await f.window.__speakerFloor.close();
  });
}
