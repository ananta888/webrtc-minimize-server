import { waitFixtureValue } from "./machine-browser-wait.mjs";
import { NativeAudioWindowEvidence, nativeAudioMeasurementSummary } from "./native-audio-window-evidence.mjs";

/** Only two fixed synthetic fixture tones; never retain or return PCM. */
export function nativeAudioFrequencyObservation() {
  const p = window.__nativeAudioProbe;
  if (!p) return null;
  if (![44100, 48000].includes(p.context?.sampleRate) || !Array.isArray(p.analysers) || p.analysers.length !== 2
    || p.analysers.some(analyser => analyser?.fftSize !== 2048)) return null;
  // Reopening HLS replaces MediaSource and resets element counters. Keep only
  // a bounded local generation in reports, never the private source URL.
  const source = p.video.currentSrc;
  if (typeof source !== "string" || !source || source.length > 4096) return null;
  if (p.frequencySource !== source) {
    const previous = p.frequencyEpoch ?? 0;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= 64) return null;
    p.frequencySource = source; p.frequencyEpoch = previous + 1;
  }
  const peaks = [];
  const nominalChannels = p.analysers.map(analyser => {
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    // Locate only the two known fixture tones. Native asynchronous resampling
    // can move a tone off its nominal bin without reducing its amplitude.
    const weighted = new Float64Array(samples.length);
    let weights = 0;
    for (let i = 0; i < samples.length; i++) {
      const w = .5 * (1 - Math.cos(2 * Math.PI * i / (samples.length - 1)));
      weighted[i] = samples[i] * w; weights += w;
    }
    const magnitude = frequency => {
      const angle = 2 * Math.PI * frequency / p.context.sampleRate;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      let re = 0, im = 0, c = 1, s = 0;
      for (const value of weighted) {
        re += value * c; im -= value * s;
        const next = c * cos - s * sin; s = s * cos + c * sin; c = next;
      }
      return 2 * Math.hypot(re, im) / weights;
    };
    peaks.push([440, 880].map(nominal => {
      const low = nominal * .9, high = nominal * 1.1, step = p.context.sampleRate / samples.length / 4;
      let best = low, amplitude = -1;
      for (let frequency = low; frequency <= high; frequency += step) {
        const value = magnitude(frequency);
        if (value > amplitude) { best = frequency; amplitude = value; }
      }
      let left = Math.max(low, best - step), right = Math.min(high, best + step);
      for (let i = 0; i < 12; i++) {
        const a = left + (right - left) / 3, b = right - (right - left) / 3;
        if (magnitude(a) > magnitude(b)) right = b; else left = a;
      }
      const frequency = (left + right) / 2;
      return { frequency, amplitude: magnitude(frequency) };
    }));
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
  const channels = peaks.map(row => row.map((peak, tone) => {
    const nominal = [440, 880][tone];
    // Preserve the existing silence threshold. An inaudible search result has
    // no meaningful peak frequency; a detectable out-of-band tone is invalid.
    const supported = peak.frequency >= nominal / 1.05 - .2 && peak.frequency <= nominal / .95 + .2;
    return peak.amplitude < .0002 || supported ? peak.amplitude : NaN;
  }));
  return { channels, spectral: { peaks, nominalChannels, sampleRate: p.context.sampleRate, playbackRate: p.video.playbackRate },
    mediaEpoch: p.frequencyEpoch, time: p.video.currentTime, frames: p.video.getVideoPlaybackQuality().totalVideoFrames,
    ready: p.video.readyState, paused: p.video.paused, contextRunning: p.context.state === "running" };
}

const targets = Object.freeze({ unprocessed: [1, 1], balanced: [1, .5], "speech-first": [1, .28], "screen-first": [.28, 1] });
const amplitudes = channels => Array.isArray(channels) && channels.length === 2
  && channels.every(row => Array.isArray(row) && row.length === 2 && row.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
const validEpoch = epoch => Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= 64;
const playing = value => amplitudes(value?.channels) && Number.isFinite(value.time) && value.time >= 0
  && Number.isSafeInteger(value.frames) && value.frames >= 1 && Number.isFinite(value.ready) && value.ready >= 2
  && validEpoch(value.mediaEpoch) && value.paused === false && value.contextRunning === true;
const baselineValid = baseline => amplitudes(baseline?.channels) && baseline.channels.every(row => row.every(v => v > .02));
// native-scene-live-fixture generates both oscillators with gain .25. Mere
// audibility is not a full-level reference: decoder startup can ramp a tone.
const calibratedLevels = value => value.channels.every(row => row.every(v => v >= .225 && v <= .275));
const stableLevels = (first, value) => value.channels.every((row, channel) => row.every((v, tone) =>
  Math.abs(v - first.channels[channel][tone]) <= first.channels[channel][tone] * .02));

export function nativeAudioStrategyMatches(value, strategy, baseline = null) {
  if (!Object.hasOwn(targets, strategy) || !playing(value)) return false;
  if (baseline === null) return strategy === "unprocessed" && calibratedLevels(value);
  if (!baselineValid(baseline)) return false;
  return value.channels.every((row, channel) => row.every((v, tone) =>
    Math.abs(v / baseline.channels[channel][tone] - targets[strategy][tone]) < .1));
}

/** Not a mixing strategy: evidence that the retained mic actually contributes
 * after the screen source was revoked, before expecting its own encoder fence. */
export function nativeAudioMicrophoneOnlyMatches(value, baseline) {
  return playing(value) && baselineValid(baseline)
    && value.channels.every((row, channel) => Math.abs(row[0] / baseline.channels[channel][0] - 1) < .1 && row[1] < .0002);
}

export async function waitNativeAudioStrategy(page, strategy, baseline = null) {
  if (!Object.hasOwn(targets, strategy) || baseline === null && strategy !== "unprocessed") throw new Error("test_audio_strategy_invalid");
  return waitFrequencyMatch(page, value => nativeAudioStrategyMatches(value, strategy, baseline),
    { code: "test_audio_strategy_unconfirmed", strategy, phase: baseline === null ? "calibration" : "strategy" }, baseline === null);
}

export async function waitNativeMicrophoneAfterScreenRevoke(page, baseline, previous) {
  if (!baselineValid(baseline) || !Number.isFinite(previous?.time) || previous.time < 0
    || !Number.isSafeInteger(previous.frames) || previous.frames < 1
    || !validEpoch(previous.mediaEpoch)) throw new Error("test_audio_retained_source_invalid");
  return waitFrequencyMatch(page, value => nativeAudioMicrophoneOnlyMatches(value, baseline)
    && (value.mediaEpoch > previous.mediaEpoch || value.mediaEpoch === previous.mediaEpoch
      && value.time > previous.time && value.frames > previous.frames), { code: "test_audio_retained_source_unconfirmed" });
}

async function waitFrequencyMatch(page, matches, diagnostic, requireStableLevels = false) {
  let first = null, previous = null, latest = null;
  const evidence = new NativeAudioWindowEvidence();
  const result = await waitFixtureValue(page, nativeAudioFrequencyObservation, undefined, { timeout: 20000, accept: value => {
    latest = value;
    if (!matches(value)) {
      evidence.record(value, playing(value) ? "target-mismatch" : "not-playing", null);
      first = null; previous = null; return false;
    }
    const reset = previous && value.mediaEpoch !== previous.mediaEpoch ? "generation"
      : previous && value.time < previous.time ? "time-rollback"
      : previous && value.frames < previous.frames ? "frame-rollback"
      : first && requireStableLevels && !stableLevels(first, value) ? "level-drift" : null;
    if (reset) first = null;
    const reason = reset || (first ? "continue" : "start");
    previous = value;
    first ??= value;
    evidence.record(value, reason, first);
    return value.time - first.time >= 1 && value.frames > first.frames;
  } }).catch(error => { throw new Error(JSON.stringify({ ...diagnostic, latest: nativeAudioMeasurementSummary(latest),
    failure: error?.message === "test_fixture_wait_deadline" ? "deadline" : "observation-failed",
    windowEvidence: evidence.snapshot() })); });
  return { channels: result.channels, mediaEpoch: result.mediaEpoch, time: result.time, frames: result.frames,
    ...(result.spectral ? { spectral: nativeAudioMeasurementSummary(result).spectral } : {}) };
}
