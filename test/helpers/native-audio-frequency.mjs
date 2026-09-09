import { waitFixtureValue } from "./machine-browser-wait.mjs";

/** Only two fixed synthetic fixture tones; never retain or return PCM. */
export function nativeAudioFrequencyObservation() {
  const p = window.__nativeAudioProbe;
  if (!p) return null;
  const channels = p.analysers.map(analyser => {
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    // Hann-windowed DFT avoids dependence on FFT-bin alignment or oscillator phase.
    return [440, 880].map(frequency => {
      let real = 0, imaginary = 0, weight = 0;
      for (let i = 0; i < samples.length; i++) {
        const w = .5 * (1 - Math.cos(2 * Math.PI * i / (samples.length - 1)));
        const angle = 2 * Math.PI * frequency * i / p.context.sampleRate;
        real += samples[i] * w * Math.cos(angle);
        imaginary -= samples[i] * w * Math.sin(angle); weight += w;
      }
      return 2 * Math.hypot(real, imaginary) / weight;
    });
  });
  return { channels, time: p.video.currentTime, frames: p.video.getVideoPlaybackQuality().totalVideoFrames,
    ready: p.video.readyState, paused: p.video.paused, contextRunning: p.context.state === "running" };
}

const targets = Object.freeze({ unprocessed: [1, 1], balanced: [1, .5], "speech-first": [1, .28], "screen-first": [.28, 1] });
const amplitudes = channels => Array.isArray(channels) && channels.length === 2
  && channels.every(row => Array.isArray(row) && row.length === 2 && row.every(v => Number.isFinite(v) && v >= 0 && v <= 1));

export function nativeAudioStrategyMatches(value, strategy, baseline = null) {
  if (!Object.hasOwn(targets, strategy) || !amplitudes(value?.channels)
    || !Number.isFinite(value.time) || value.time < 0 || !Number.isSafeInteger(value.frames) || value.frames < 1
    || value.ready < 2 || value.paused !== false || value.contextRunning !== true) return false;
  if (baseline === null) return strategy === "unprocessed" && value.channels.every(row => row.every(v => v > .02));
  if (!amplitudes(baseline.channels) || !baseline.channels.every(row => row.every(v => v > .02))) return false;
  return value.channels.every((row, channel) => row.every((v, tone) =>
    Math.abs(v / baseline.channels[channel][tone] - targets[strategy][tone]) < .1));
}

export async function waitNativeAudioStrategy(page, strategy, baseline = null) {
  if (!Object.hasOwn(targets, strategy) || baseline === null && strategy !== "unprocessed") throw new Error("test_audio_strategy_invalid");
  let first = null, latest = null;
  const result = await waitFixtureValue(page, nativeAudioFrequencyObservation, undefined, { timeout: 20000, accept: value => {
    latest = value;
    if (!nativeAudioStrategyMatches(value, strategy, baseline)) { first = null; return false; }
    first ??= value;
    return value.time - first.time >= 1 && value.frames > first.frames;
  } }).catch(() => { throw new Error(JSON.stringify({ code: "test_audio_strategy_unconfirmed", strategy, latest })); });
  return { channels: result.channels, time: result.time, frames: result.frames };
}
