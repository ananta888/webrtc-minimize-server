import assert from "node:assert/strict";
import test from "node:test";
import { NativeAudioWindowEvidence, nativeAudioMeasurementSummary } from "./helpers/native-audio-window-evidence.mjs";
import { waitNativeAudioStrategy } from "./helpers/native-audio-frequency.mjs";

const sample = (time, level = .25, mediaEpoch = 1) => ({ channels: [[level, level], [level, level]],
  time, frames: Math.round(time * 15) + 1, mediaEpoch, ready: 4, paused: false, contextRunning: true });

test("window evidence keeps only eight immutable numeric projections and saturates fixed counters", () => {
  const evidence = new NativeAudioWindowEvidence(), value = { ...sample(1), token: "private-token-canary", url: "https://private-source" };
  evidence.record(value, "start", value);
  const before = evidence.snapshot();
  value.channels[0][0] = .1;
  for (let i = 0; i < 1002; i++) evidence.record(sample(1 + i / 10000), "continue", sample(1));
  const after = evidence.snapshot();
  assert.equal(after.recent.length, 8);
  assert.equal(after.counts.continue, 1000); assert.equal(after.saturated, true);
  assert.equal(before.counts.continue, 0); assert.equal(before.recent.length, 1);
  assert.equal(before.recent[0].sample.channels[0][0], .25);
  for (const value of [before, before.counts, before.recent, before.recent[0], before.recent[0].sample,
    before.recent[0].sample.channels, before.recent[0].sample.channels[0]]) assert.ok(Object.isFrozen(value));
  assert.doesNotMatch(JSON.stringify(before) + JSON.stringify(after), /private|token|https/);
  assert.ok(JSON.stringify(after).length < 4096);
  assert.throws(() => evidence.record(value, "private-reason", value), /test_audio_window_reason_invalid/);
});

test("malformed page fields cannot enter the audio diagnostic as raw text or unbounded arrays", () => {
  for (const value of [null, false, "private", []]) assert.equal(nativeAudioMeasurementSummary(value), null);
  const bad = nativeAudioMeasurementSummary({ channels: [["private-token", Infinity], [NaN, -1]], time: "https://private",
    mediaEpoch: 65, frames: "caption", ready: 5, paused: "name", contextRunning: "room" });
  assert.deepEqual(bad, { channels: [[null, null], [null, null]], time: null, mediaEpoch: null, frames: null,
    ready: null, paused: null, contextRunning: null });
  for (const channels of [Array(10000).fill("private"), [[.25], [.25]], [[.25, .25, .25], [.25, .25]]]) {
    assert.equal(nativeAudioMeasurementSummary({ ...sample(1), channels }).channels, null);
  }
  for (const value of [-1, Infinity, NaN, Number.MAX_VALUE]) {
    assert.equal(nativeAudioMeasurementSummary({ ...sample(1), time: value }).time, null);
  }
});

test("real strategy poll distinguishes all reset reasons without relaxing its stable window", async () => {
  const sequence = [null, sample(1, .15), sample(1), sample(1.5), sample(1.75, .24), sample(1.6, .24),
    { ...sample(1.7, .24), frames: 10 }, sample(.1, .24, 2), sample(.6, .24, 2)];
  let reads = 0;
  const page = { evaluate: async () => {
    if (reads === sequence.length) throw new Error("private-token-and-source-url");
    return sequence[reads++];
  } };
  await assert.rejects(waitNativeAudioStrategy(page, "unprocessed"), error => {
    assert.doesNotMatch(error.message, /private-token|source-url/);
    const diagnostic = JSON.parse(error.message), window = diagnostic.windowEvidence;
    assert.equal(diagnostic.phase, "calibration"); assert.equal(diagnostic.failure, "observation-failed");
    assert.deepEqual(window.counts, { "not-playing": 1, "target-mismatch": 1, generation: 1,
      "time-rollback": 1, "frame-rollback": 1, "level-drift": 1, start: 1, continue: 2 });
    assert.equal(window.longestSeconds, .5); assert.ok(window.largestFrameAdvance > 0);
    assert.equal(window.recent.length, 8); assert.equal(window.recent.at(-1).spanSeconds, .5);
    assert.equal(diagnostic.latest.mediaEpoch, 2);
    return true;
  });
  assert.equal(reads, sequence.length);
});

test("optional spectral evidence is bounded, immutable and cannot retain arbitrary page data", () => {
  const peak = { frequency: 892.25, amplitude: .25, token: "secret-canary" };
  const spectral = { peaks: [[peak, peak], [peak, peak]], sampleRate: 48000, playbackRate: 1, pcm: ["private"] };
  const result = nativeAudioMeasurementSummary({ ...sample(1), spectral });
  peak.amplitude = 0;
  assert.equal(result.spectral.peaks[0][0].amplitude, .25);
  assert.ok(Object.isFrozen(result.spectral.peaks[0][0]));
  assert.doesNotMatch(JSON.stringify(result), /secret|token|private|pcm/);
  const evidence = new NativeAudioWindowEvidence();
  for (let i = 0; i < 20; i++) evidence.record({ ...sample(1 + i / 10), spectral }, "continue", sample(1));
  assert.equal(evidence.snapshot().recent.length, 8);
  assert.ok(JSON.stringify(evidence.snapshot()).length < 8192);
  for (const peaks of [Array(10000).fill(peak), [[peak], [peak]], "private"]) {
    assert.equal(nativeAudioMeasurementSummary({ ...sample(1), spectral: { ...spectral, peaks } }).spectral.peaks, null);
  }
  const bad = nativeAudioMeasurementSummary({ ...sample(1), spectral: { peaks: [[{ frequency: "secret", amplitude: Infinity }, null], [false, {}]],
    sampleRate: "private", playbackRate: -1 } });
  assert.deepEqual(bad.spectral, { peaks: [[{ frequency: null, amplitude: null }, { frequency: null, amplitude: null }],
    [{ frequency: null, amplitude: null }, { frequency: null, amplitude: null }]], nominalChannels: null, sampleRate: null, playbackRate: null });
});

test("deadline diagnostics distinguish a pending observation from a page exception", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const pending = waitNativeAudioStrategy({ evaluate: () => new Promise(resolve => { release = resolve; }) }, "unprocessed");
  const rejected = assert.rejects(pending, error => {
    const diagnostic = JSON.parse(error.message);
    assert.equal(diagnostic.failure, "deadline"); assert.equal(diagnostic.latest, null);
    assert.equal(diagnostic.windowEvidence.recent.length, 0);
    assert.equal(diagnostic.windowEvidence.longestSeconds, 0);
    return true;
  });
  t.mock.timers.tick(20000); await rejected;
  release(sample(1)); await Promise.resolve();
});
