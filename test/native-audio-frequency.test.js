import assert from "node:assert/strict";
import test from "node:test";
import { nativeAudioFrequencyObservation, nativeAudioStrategyMatches } from "./helpers/native-audio-frequency.mjs";

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
        video: { currentTime: 5, getVideoPlaybackQuality: () => ({ totalVideoFrames: 75 }), readyState: 4, paused: false },
      } };
      const result = nativeAudioFrequencyObservation();
      for (const [channel, expected] of [[0, [.25, .2]], [1, [.125, .05]]]) {
        for (let tone = 0; tone < 2; tone++) assert.ok(Math.abs(result.channels[channel][tone] - expected[tone]) < .001);
      }
      assert.equal(nativeAudioStrategyMatches(result, "unprocessed"), true);
      assert.deepEqual(Object.keys(result).sort(), ["channels", "contextRunning", "frames", "paused", "ready", "time"]);
    }
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test("strategy evidence rejects missing tone, wrong priority, stopped output and invalid measurements", () => {
  const baseline = { channels: [[.25, .25], [.125, .0625]] };
  const output = factors => ({ ...baseline, channels: baseline.channels.map(row => row.map((v, tone) => v * factors[tone])),
    time: 5, frames: 75, ready: 4, paused: false, contextRunning: true });
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
