import assert from "node:assert/strict";
import test from "node:test";
import { nativeAudioFrequencyObservation, nativeAudioStrategyMatches, nativeAudioMicrophoneOnlyMatches,
  waitNativeMicrophoneAfterScreenRevoke } from "./helpers/native-audio-frequency.mjs";

test("retained audio freshness follows output generations when HLS resets time and frame counters", async () => {
  const baseline = { channels: [[.25, .25], [.25, .25]] };
  const value = (mediaEpoch, time, frames) => ({ channels: [[.25, 0], [.25, 0]], mediaEpoch,
    time, frames, ready: 4, paused: false, contextRunning: true });
  const sequence = [value(1, 20, 300), value(2, 1, 15), value(2, 1.5, 22),
    value(3, 2, 30), value(3, 2.5, 37), value(3, 3, 45)];
  let reads = 0;
  const page = { evaluate: async () => { assert.ok(reads < sequence.length, "bounded generation observations"); return sequence[reads++]; } };
  assert.deepEqual(await waitNativeMicrophoneAfterScreenRevoke(page, baseline, { mediaEpoch: 1, time: 28, frames: 424 }),
    { channels: [[.25, 0], [.25, 0]], mediaEpoch: 3, time: 3, frames: 45 });
  assert.equal(reads, sequence.length, "the stable interval cannot span two media generations");
});

test("fixed synthetic DFT separates both tones in both channels regardless of phase or sample rate", () => {
  const previous = globalThis.window;
  try {
    for (const sampleRate of [44100, 48000]) for (const phase of [0, 1, 4]) {
      globalThis.window = { __nativeAudioProbe: {
        analysers: [[.25, .2], [.125, .05]].map(([mic, screen]) => ({ fftSize: 2048,
          getFloatTimeDomainData(samples) {
            for (let i = 0; i < samples.length; i++) samples[i] = mic * Math.sin(2 * Math.PI * 440 * i / sampleRate + phase)
              + screen * Math.sin(2 * Math.PI * 880 * i / sampleRate - phase);
          } })), context: { sampleRate, state: "running" },
        video: { currentSrc: "blob:synthetic-one", currentTime: 5, getVideoPlaybackQuality: () => ({ totalVideoFrames: 75 }), readyState: 4, paused: false },
      } };
      const result = nativeAudioFrequencyObservation();
      for (const [channel, expected] of [[0, [.25, .2]], [1, [.125, .05]]]) {
        for (let tone = 0; tone < 2; tone++) assert.ok(Math.abs(result.channels[channel][tone] - expected[tone]) < .001);
      }
      assert.equal(nativeAudioStrategyMatches(result, "unprocessed"), true);
      assert.deepEqual(Object.keys(result).sort(), ["channels", "contextRunning", "frames", "mediaEpoch", "paused", "ready", "time"]);
      assert.equal(result.mediaEpoch, 1); assert.equal(nativeAudioFrequencyObservation().mediaEpoch, 1);
      globalThis.window.__nativeAudioProbe.video.currentSrc = "blob:synthetic-two";
      assert.equal(nativeAudioFrequencyObservation().mediaEpoch, 2);
      assert.doesNotMatch(JSON.stringify(result), /blob|synthetic/);
      globalThis.window.__nativeAudioProbe.video.currentSrc = "";
      assert.equal(nativeAudioFrequencyObservation(), null);
      globalThis.window.__nativeAudioProbe.video.currentSrc = "blob:synthetic-three";
      globalThis.window.__nativeAudioProbe.frequencyEpoch = 64;
      assert.equal(nativeAudioFrequencyObservation(), null, "generation counter remains bounded");
    }
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test("retained microphone evidence requires both live channels without the revoked screen tone", () => {
  const baseline = { channels: [[.25, .25], [.125, .0625]] };
  const value = { channels: [[.25, .00001], [.125, .00001]], mediaEpoch: 1, time: 10, frames: 150,
    ready: 4, paused: false, contextRunning: true };
  assert.equal(nativeAudioMicrophoneOnlyMatches(value, baseline), true);
  for (const changed of [{ channels: baseline.channels }, { channels: [[.25, .001], [.125, 0]] },
    { channels: [[.25, 0], [.125, .001]] }, { channels: [[.07, 0], [.035, 0]] },
    { channels: [[0, 0], [0, 0]] }, { channels: [[.25, 0], [0, 0]] },
    { channels: [[NaN, 0], [.125, 0]] }, { channels: [[.25, 0]] },
    { paused: true }, { contextRunning: false }, { ready: undefined }, { ready: NaN },
    { frames: 0 }, { time: Infinity }, { mediaEpoch: 0 }, { mediaEpoch: 65 }, { mediaEpoch: undefined }]) {
    assert.equal(nativeAudioMicrophoneOnlyMatches({ ...value, ...changed }, baseline), false);
  }
  for (const invalid of [null, {}, { channels: [[0, 0], [0, 0]] }]) {
    assert.equal(nativeAudioMicrophoneOnlyMatches(value, invalid), false);
  }
});

test("retained-source wait rejects old frames and resets its stable interval when screen tone returns", async () => {
  const baseline = { channels: [[.25, .25], [.25, .25]] };
  const value = (time, frames, screen = 0) => ({ channels: [[.25, screen], [.25, screen]],
    mediaEpoch: 1, time, frames, ready: 4, paused: false, contextRunning: true });
  const sequence = [value(8, 120), value(10, 150), value(11, 150), value(11, 165),
    value(11.5, 170, .25), value(12, 180), value(12.5, 185), value(13, 195)];
  let reads = 0;
  const page = { evaluate: async () => { assert.ok(reads < sequence.length, "bounded fixture observations"); return sequence[reads++]; } };
  assert.deepEqual(await waitNativeMicrophoneAfterScreenRevoke(page, baseline, { mediaEpoch: 1, time: 10, frames: 150 }),
    { channels: [[.25, 0], [.25, 0]], mediaEpoch: 1, time: 13, frames: 195 });
  assert.equal(reads, sequence.length);
  for (const previous of [null, {}, { time: 10, frames: 0 }, { time: NaN, frames: 150 }]) {
    await assert.rejects(waitNativeMicrophoneAfterScreenRevoke(page, baseline, previous), /test_audio_retained_source_invalid/);
  }
  assert.equal(reads, sequence.length, "invalid anchors never inspect the page");
});

test("strategy evidence rejects missing tone, wrong priority, stopped output and invalid measurements", () => {
  const baseline = { channels: [[.25, .25], [.125, .0625]] };
  const output = factors => ({ ...baseline, channels: baseline.channels.map(row => row.map((v, tone) => v * factors[tone])),
    mediaEpoch: 1, time: 5, frames: 75, ready: 4, paused: false, contextRunning: true });
  for (const [strategy, factors] of Object.entries({ unprocessed: [1, 1], balanced: [1, .5], "speech-first": [1, .28], "screen-first": [.28, 1] })) {
    const value = output(factors);
    assert.equal(nativeAudioStrategyMatches(value, strategy, baseline), true);
    for (const changed of [{ paused: true }, { contextRunning: false }, { ready: 1 }, { time: NaN }, { frames: 0 },
      { channels: [[0, 0], [0, 0]] }, { channels: [[Infinity, 1], [1, 1]] }]) {
      assert.equal(nativeAudioStrategyMatches({ ...value, ...changed }, strategy, baseline), false);
    }
  }
  assert.equal(nativeAudioStrategyMatches(output([.28, 1]), "speech-first", baseline), false);
  assert.equal(nativeAudioStrategyMatches(output([1, 1]), "balanced", baseline), false);
  assert.equal(nativeAudioStrategyMatches(output([1, 1]), "unknown", baseline), false);
  assert.equal(nativeAudioStrategyMatches(output([1, 1]), "constructor", baseline), false);
  assert.equal(nativeAudioStrategyMatches(output([1, .5]), "balanced"), false);
  assert.equal(nativeAudioStrategyMatches(output([1, 1]), "balanced", { channels: [[0, 0], [0, 0]] }), false);
});
