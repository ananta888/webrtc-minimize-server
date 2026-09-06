import { boundedBroadcastMediaStart } from "./broadcast-media-start";

/** Bounds local rendering setup only; never requests capture or resumes audio. */
export async function playTrustedVideo(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  await boundedBroadcastMediaStart(() => video.play(), signal, "trusted_video_play_timeout", "trusted_video_play_failed");
}
