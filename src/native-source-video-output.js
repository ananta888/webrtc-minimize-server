/** Closed output strategies within the existing H.264/AAC 720p codec family.
 * These describe encoder outputs, not input detail or room capture quality. */
const PROFILES = Object.freeze({
  "balanced-v1": Object.freeze([[640, 360, 15, 500000], [960, 540, 24, 1100000], [1280, 720, 30, 2400000]].map(Object.freeze)),
  "economy-v1": Object.freeze([[426, 240, 10, 250000], [640, 360, 15, 500000], [960, 540, 15, 900000]].map(Object.freeze)),
  "screen-v1": Object.freeze([[640, 360, 10, 400000], [960, 540, 10, 800000], [1280, 720, 10, 1400000]].map(Object.freeze)),
});

export function normalizeNativeSourceVideoOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, "profile")
    || typeof value.profile !== "string" || !Object.hasOwn(PROFILES, value.profile)) {
    throw new Error("invalid_native_source_video_output");
  }
  return Object.freeze({ profile: value.profile });
}

export function nativeSourceVideoRenditions(selection, standard) {
  const profile = normalizeNativeSourceVideoOutput(selection).profile;
  return Object.freeze(standard.map((rendition, index) => {
    const [width, height, framesPerSecond, videoBitsPerSecond] = PROFILES[profile][index];
    return Object.freeze({ ...rendition, width, height, framesPerSecond, videoBitsPerSecond });
  }));
}

/** Preserve the explicit v3 null audio choice across readmission and handoff. */
export function nativeOutputRequestFields(audioOutput, videoOutput) {
  return videoOutput ? { requestVersion: 3, videoOutput, audioOutput: audioOutput ?? null }
    : audioOutput ? { requestVersion: 2, audioOutput } : { requestVersion: 1 };
}
