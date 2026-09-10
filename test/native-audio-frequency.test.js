import assert from "node:assert/strict";
import test from "node:test";
import { nativeAudioFrequencyObservation, nativeAudioStrategyMatches, nativeAudioMicrophoneOnlyMatches,
  waitNativeMicrophoneAfterScreenRevoke, waitNativeAudioStrategy } from "./helpers/native-audio-frequency.mjs";

const toneValue = (amplitude, time, mediaEpoch = 1) => ({ channels: [[.25, amplitude], [.25, amplitude]],
  mediaEpoch, time, frames: Math.round(time * 15) + 1, ready: 4, paused: false, contextRunning: true });

test("recorded low CI reference is not a calibrated full-level baseline", () => {
  const baseline = { ...toneValue(.15502754521258622, 15.501333),
    channels: [[.24730195705274544, .15502754521258622], [.2473019551676795, .15502754505717414]] };
  const balanced = { ...toneValue(.124679787656311, 35.944),
    channels: [[.25117954619903865, .124679787656311], [.25117954161970213, .12467978764831991]] };
  assert.equal(nativeAudioStrategyMatches(baseline, "unprocessed"), false);
  assert.equal(nativeAudioStrategyMatches(balanced, "balanced", baseline), false, "do not widen relative strategy tolerances");
  assert.equal(nativeAudioStrategyMatches(balanced, "balanced", toneValue(.25, 20)), true);
});

test("calibration requires the known amplitude in every channel and every tone", () => {
  for (const level of [.225, .25, .275]) {
    const good = { ...toneValue(level, 1), channels: [[level, level], [level, level]] };
    assert.equal(nativeAudioStrategyMatches(good, "unprocessed"), true);
  }
  for (let channel = 0; channel < 2; channel++) for (let tone = 0; tone < 2; tone++) {
    for (const level of [0, .02, .155, .2249, .2751, 1, NaN, Infinity]) {
      const bad = toneValue(.25, 1); bad.channels[channel][tone] = level;
      assert.equal(nativeAudioStrategyMatches(bad, "unprocessed"), false);
    }
  }
});

for (let channel = 0; channel < 2; channel++) for (let tone = 0; tone < 2; tone++) {
  test(`calibration stability includes channel ${channel} tone ${tone}`, async () => {
    const sequence = [1, 1.5, 2, 2.5, 3].map(time => toneValue(.25, time));
    sequence[0].channels[channel][tone] = .23;
    sequence[1].channels[channel][tone] = .24;
    let reads = 0;
    const page = { evaluate: async () => { assert.ok(reads < sequence.length); return sequence[reads++]; } };
    await waitNativeAudioStrategy(page, "unprocessed");
    assert.equal(reads, sequence.length);
  });
}

test("calibration keeps its 20-second deadline and ignores a late successful observation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release, reads = 0;
  const page = { evaluate: () => { reads++; return new Promise(resolve => { release = resolve; }); } };
  const pending = waitNativeAudioStrategy(page, "unprocessed");
  let settled = false;
  const rejected = assert.rejects(pending, error => {
    settled = true;
    const diagnostic = JSON.parse(error.message);
    return diagnostic.code === "test_audio_strategy_unconfirmed" && diagnostic.phase === "calibration";
  });
  t.mock.timers.tick(19999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected;
  release(toneValue(.25, 5)); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1);
});

for (const [name, sequence] of [
  ["persistent low level then full output", [toneValue(.155, 1), toneValue(.155, 1.5), toneValue(.155, 2),
    toneValue(.25, 3), toneValue(.25, 3.5), toneValue(.25, 4)]],
  ["ramp inside the absolute band", [toneValue(.23, 1), toneValue(.24, 1.5), toneValue(.25, 2),
    toneValue(.25, 2.5), toneValue(.25, 3)]],
  ["level drops during the calibration window", [toneValue(.25, 1), toneValue(.25, 1.5), toneValue(.15, 2),
    toneValue(.25, 3), toneValue(.25, 3.5), toneValue(.25, 4)]],
  ["new output generation", [toneValue(.25, 1), toneValue(.25, 1.5), toneValue(.25, 1, 2),
    toneValue(.25, 1.5, 2), toneValue(.25, 2, 2)]],
  ["time rollback above the window start", [toneValue(.25, 1), toneValue(.25, 1.75), toneValue(.25, 1.5),
    toneValue(.25, 2), toneValue(.25, 2.5)]],
  ["frame rollback above the window start", [toneValue(.25, 1), toneValue(.25, 1.5),
    { ...toneValue(.25, 1.75), frames: 20 }, toneValue(.25, 2), toneValue(.25, 2.75)]],
]) test(`baseline wait requires full and stable level: ${name}`, async () => {
  let reads = 0;
  const page = { evaluate: async () => { assert.ok(reads < sequence.length, "bounded fixture reads"); return sequence[reads++]; } };
  const result = await waitNativeAudioStrategy(page, "unprocessed");
  const final = sequence.at(-1);
  assert.equal(reads, sequence.length, "reference must not be accepted before the complete calibration window");
  assert.deepEqual(result, { channels: final.channels, mediaEpoch: final.mediaEpoch, time: final.time, frames: final.frames });
  for (const [strategy, factors] of Object.entries({ unprocessed: [1, 1], balanced: [1, .5], "speech-first": [1, .28], "screen-first": [.28, 1] })) {
    const correct = { ...final, channels: final.channels.map(row => row.map((value, tone) => value * factors[tone])) };
    assert.equal(nativeAudioStrategyMatches(correct, strategy, result), true);
  }
});

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
      assert.equal(nativeAudioStrategyMatches(result, "unprocessed", { channels: [[.25, .2], [.125, .05]] }), true);
      assert.equal(nativeAudioStrategyMatches(result, "unprocessed"), false, "unequal test tones are not the full-level fixture baseline");
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
