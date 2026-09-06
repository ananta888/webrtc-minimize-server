import { BroadcastBrowserPortError } from "./broadcast-ports";

/** Bounds local rendering setup only; never requests capture or resumes audio. */
export async function playTrustedVideo(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(() => finish(new BroadcastBrowserPortError("trusted_video_play_timeout")), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const failed = (error: unknown) => finish(error ?? new BroadcastBrowserPortError("trusted_video_play_failed"));
    try { Promise.resolve(video.play()).then(() => finish(), failed); }
    catch (error) { failed(error); }
  });
}
