// Test evidence only: a sampled quiet window is not media or session authority.
export function reconnectQuietWindow(now = () => performance.now()) {
  let since = null, previous = null, tracks = null;
  return value => {
    if (!value || Object.keys(value).sort().join(",") !== "active,failed,tracks"
      || value.failed !== false || typeof value.active !== "boolean"
      || !Number.isInteger(value.tracks) || value.tracks < 1 || value.tracks > 4) {
      throw new Error("test_reconnect_audio_observation_invalid");
    }
    const time = now();
    if (!Number.isFinite(time) || time < 0 || previous !== null && time < previous) {
      throw new Error("test_reconnect_audio_clock_invalid");
    }
    if (previous !== null && time - previous > 150 || tracks !== value.tracks) since = null;
    previous = time; tracks = value.tracks;
    if (value.active) since = null;
    else since ??= time;
    return since !== null && time - since >= 300;
  };
}
