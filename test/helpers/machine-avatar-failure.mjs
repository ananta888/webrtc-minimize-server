// Only fixed categories and bounded numeric observations of synthetic fixtures.
// Never serialize the arbitrary Error object or raw browser status.
export function avatarFailureSnapshot(phase, observation, source) {
  const bounded = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  const sample = observation?.sample;
  return {
    phase: ["loop", "image", "hold", "stop"].includes(phase) ? phase : "unknown",
    sample: { center: Array.isArray(sample?.center) && sample.center.length === 4
      && sample.center.every(value => bounded(value, 255) !== null) ? [...sample.center] : null,
    white: bounded(sample?.white, 6480), bright: bounded(sample?.bright, 200),
    decodedWidth: [64, 128, 256].includes(sample?.decodedWidth) ? sample.decodedWidth : null },
    videos: Array.isArray(observation?.videos) ? observation.videos.slice(0, 8).map(video => ({
      width: bounded(video?.width, 8192), height: bounded(video?.height, 8192),
      ready: bounded(video?.ready, 4), attached: typeof video?.attached === "boolean" ? video.attached : null,
    })) : [],
    transformErrors: bounded(observation?.transformErrors, 128),
    captureCalls: bounded(observation?.captureCalls, 1000),
    source: { state: ["closed", "opening", "open", "waiting", "failed"].includes(source?.state) ? source.state : "unknown",
      generation: bounded(source?.generation, 4096), frames: bounded(source?.frames, 100000) },
  };
}
