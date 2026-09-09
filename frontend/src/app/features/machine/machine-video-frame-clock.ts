import { MEDIA_AGE_US } from "./machine-media-timeline";

export interface DecodedFramePosition { positionUs: number; held: boolean }
export interface VideoFrameClock { read(): DecodedFramePosition | null; close(): void }

/** Actual compositor-frame PTS only; never estimates missing loop counts or receiver delivery. */
export function observeOwnedVideoFrames(video: HTMLVideoElement, loop: boolean,
  nowUs: () => number = () => Math.floor(performance.now() * 1000)): VideoFrameClock {
  if (typeof video.requestVideoFrameCallback !== "function" || typeof video.cancelVideoFrameCallback !== "function") {
    throw new Error("meet_video_frame_clock_unsupported");
  }
  let handle: number | undefined, closed = false, failed = false;
  let previous: { media: number; frames: number; at: number } | undefined;
  let offset = 0, duration: number | undefined;
  const clock = () => {
    const now = nowUs();
    if (!Number.isSafeInteger(now) || now < 0 || now > 86_400_000_000 || previous && now < previous.at) throw new Error();
    return now;
  };
  const schedule = () => { handle = video.requestVideoFrameCallback((_now, metadata) => {
    if (closed || failed) return;
    handle = undefined;
    try {
      const at = clock(), media = Math.round(metadata.mediaTime * 1_000_000);
      const length = Math.round(video.duration * 1_000_000), frames = metadata.presentedFrames;
      if (!Number.isSafeInteger(media) || media < 0 || !Number.isSafeInteger(length) || length <= 0 || length > 10_100_000
        || media > length || !Number.isSafeInteger(frames) || frames < 1 || frames > 2 ** 32 - 1
        || metadata.width !== 256 || metadata.height !== 256 || duration !== undefined && duration !== length) throw new Error();
      if (previous) {
        // At most one wrap can be observed unambiguously. Never infer skipped full cycles.
        if (frames <= previous.frames || at - previous.at > MEDIA_AGE_US || loop && at - previous.at >= length) throw new Error();
        if (media < previous.media) { if (!loop) throw new Error(); offset += length; }
      }
      if (offset + media > 86_400_000_000) throw new Error();
      duration = length; previous = { media, frames, at }; schedule();
    } catch { failed = true; }
  }); };
  schedule();
  return { read: () => {
    if (closed || failed) throw new Error("meet_video_frame_clock_failed");
    try {
      const now = clock();
      if (!previous) return null;
      const held = !loop && video.ended === true;
      if (!held && now - previous.at > MEDIA_AGE_US) throw new Error();
      return { positionUs: offset + previous.media, held };
    } catch { failed = true; throw new Error("meet_video_frame_clock_failed"); }
  }, close: () => {
    if (closed) return; closed = true;
    if (handle !== undefined) { const owned = handle; handle = undefined; video.cancelVideoFrameCallback(owned); }
  } };
}
