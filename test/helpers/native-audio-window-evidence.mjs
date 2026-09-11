// Synthetic fixture measurements only. Never retain PCM, URLs, labels or raw
// errors, including when an unexpected page result reaches the polling port.
const REASONS = Object.freeze(["not-playing", "target-mismatch", "generation", "time-rollback", "frame-rollback", "level-drift", "start", "continue"]);
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0
  && value <= Number.MAX_SAFE_INTEGER ? Math.round(value * 1000000) / 1000000 : null;

function spectralSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const peaks = Array.isArray(value.peaks) && value.peaks.length === 2
    && value.peaks.every(row => Array.isArray(row) && row.length === 2)
    ? Object.freeze(value.peaks.map(row => Object.freeze(row.map(peak => Object.freeze({
      frequency: peak?.frequency <= 2000 ? number(peak.frequency) : null,
      amplitude: peak?.amplitude <= 1 ? number(peak.amplitude) : null,
    }))))) : null;
  const nominalChannels = Array.isArray(value.nominalChannels) && value.nominalChannels.length === 2
    && value.nominalChannels.every(row => Array.isArray(row) && row.length === 2)
    ? Object.freeze(value.nominalChannels.map(row => Object.freeze(row.map(v => v <= 1 ? number(v) : null)))) : null;
  return Object.freeze({ peaks, nominalChannels, sampleRate: [44100, 48000].includes(value.sampleRate) ? value.sampleRate : null,
    playbackRate: value.playbackRate >= .5 && value.playbackRate <= 2 ? number(value.playbackRate) : null });
}

export function nativeAudioMeasurementSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const channels = Array.isArray(value.channels) && value.channels.length === 2
    && value.channels.every(row => Array.isArray(row) && row.length === 2)
    ? Object.freeze(value.channels.map(row => Object.freeze(row.map(v => typeof v === "number" && v <= 1 ? number(v) : null)))) : null;
  return Object.freeze({ channels, ...(Object.hasOwn(value, "spectral") ? { spectral: spectralSummary(value.spectral) } : {}),
    mediaEpoch: Number.isInteger(value.mediaEpoch) && value.mediaEpoch >= 1 && value.mediaEpoch <= 64 ? value.mediaEpoch : null,
    time: number(value.time), frames: Number.isSafeInteger(value.frames) && value.frames >= 0 ? value.frames : null,
    ready: Number.isInteger(value.ready) && value.ready >= 0 && value.ready <= 4 ? value.ready : null,
    paused: typeof value.paused === "boolean" ? value.paused : null,
    contextRunning: typeof value.contextRunning === "boolean" ? value.contextRunning : null });
}

export class NativeAudioWindowEvidence {
  #counts = Object.fromEntries(REASONS.map(reason => [reason, 0]));
  #recent = [];
  #longestSeconds = 0;
  #largestFrameAdvance = 0;
  #saturated = false;

  record(value, reason, first) {
    if (!REASONS.includes(reason)) throw new Error("test_audio_window_reason_invalid");
    if (this.#counts[reason] < 1000) this.#counts[reason]++;
    else this.#saturated = true;
    const span = first && value?.mediaEpoch === first.mediaEpoch ? number(value.time - first.time) : null;
    const frames = first && value?.mediaEpoch === first.mediaEpoch ? number(value.frames - first.frames) : null;
    this.#longestSeconds = Math.max(this.#longestSeconds, span ?? 0);
    this.#largestFrameAdvance = Math.max(this.#largestFrameAdvance, frames ?? 0);
    this.#recent.push(Object.freeze({ reason, spanSeconds: span, frameAdvance: frames,
      sample: nativeAudioMeasurementSummary(value) }));
    if (this.#recent.length > 8) this.#recent.shift();
  }

  snapshot() {
    return Object.freeze({ counts: Object.freeze({ ...this.#counts }), saturated: this.#saturated,
      longestSeconds: this.#longestSeconds, largestFrameAdvance: this.#largestFrameAdvance,
      recent: Object.freeze([...this.#recent]) });
  }
}
