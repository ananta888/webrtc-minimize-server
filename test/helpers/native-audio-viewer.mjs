import { waitFixtureValue } from "./machine-browser-wait.mjs";

/** Synthetic-fixture-only endpoint observation; output device receives silence. */
export async function startNativeAudioProbe(page) {
  await page.evaluate(async () => {
    const video = document.querySelector('video[aria-label="Live-Broadcast"]');
    if (!video || window.__nativeAudioProbe) throw new Error("test_audio_probe_invalid");
    const context = new AudioContext(), source = context.createMediaElementSource(video);
    const splitter = context.createChannelSplitter(2), silence = context.createGain();
    silence.gain.value = 0; source.connect(splitter); silence.connect(context.destination);
    const analysers = [0, 1].map(channel => {
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      splitter.connect(analyser, channel); analyser.connect(silence); return analyser;
    });
    await context.resume();
    window.__nativeAudioProbe = { context, video, analysers, source, splitter, silence };
  });
  await page.getByRole("button", { name: "Ton einschalten", exact: true }).click();
}

export async function waitNativeAudioLevel(page, mode, baseline = null) {
  if (!["tone", "muted", "scaled"].includes(mode) || mode === "scaled" && !baseline) throw new Error("test_audio_probe_mode");
  let first = null, latest = null;
  const result = await waitFixtureValue(page, () => {
    const p = window.__nativeAudioProbe;
    if (!p) return null;
    const channels = p.analysers.map(analyser => {
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      let squared = 0; for (const sample of samples) squared += sample * sample;
      return Math.sqrt(squared / samples.length);
    });
    return { channels, time: p.video.currentTime, frames: p.video.getVideoPlaybackQuality().totalVideoFrames,
      ready: p.video.readyState, paused: p.video.paused, contextRunning: p.context.state === "running" };
  }, undefined, { timeout: 20000, accept: value => {
    latest = value;
    const channels = value?.channels;
    const valid = channels?.length === 2 && channels.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
      && value.ready >= 2 && !value.paused && value.contextRunning;
    const matches = valid && (mode === "tone" ? channels.every(n => n > .02)
      : mode === "muted" ? channels.every(n => n < .0002)
      : channels[0] / baseline.channels[0] > .35 && channels[0] / baseline.channels[0] < .65
        && channels[1] / baseline.channels[1] > .15 && channels[1] / baseline.channels[1] < .35);
    if (!matches) { first = null; return false; }
    first ??= value;
    return value.time - first.time >= 1 && value.frames > first.frames;
  } }).catch(() => {
    // Only scalar synthetic measurements, never audio samples or raw errors.
    throw new Error(JSON.stringify({ code: "test_audio_level_unconfirmed", mode, latest }));
  });
  return { channels: result.channels, time: result.time, frames: result.frames };
}

export async function stopNativeAudioProbe(page) {
  if (page.isClosed()) return;
  await page.evaluate(async () => {
    const p = window.__nativeAudioProbe; delete window.__nativeAudioProbe;
    if (!p) return;
    p.source.disconnect(); p.splitter.disconnect(); p.analysers.forEach(a => a.disconnect()); p.silence.disconnect();
    await p.context.close();
  });
}
