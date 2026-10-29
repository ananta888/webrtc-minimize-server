import { AvatarVideoContent } from "./machine-avatar-video-contract";
import { PreparedAvatarFrame, SequenceFrameDecoder } from "./machine-avatar-sequence-preparation";
import { AVATAR_SEQUENCE_FPS } from "./machine-avatar-sequence-contract";

interface DecoderPorts {
  video(): HTMLVideoElement;
  bitmap(video: HTMLVideoElement): Promise<ImageBitmap>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}
const nativePorts: DecoderPorts = {
  video: () => document.createElement("video"), bitmap: video => createImageBitmap(video),
  createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url),
};
const release = (action: () => void) => { try { action(); } catch { /* Continue owned cleanup. */ } };

function videoEvent(video: HTMLVideoElement, event: string, signal: AbortSignal, start: () => void): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(event, ready); video.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("meet_avatar_sequence_decoder_cancelled")); };
    video.addEventListener(event, ready, { once: true }); video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", failed, { once: true });
    try { start(); } catch (error) { cleanup(); reject(error); }
  });
}

/** Owned silent blob, sequential seek/copy. No playback, external URL or capture API. */
export async function decodeAvatarSequenceClip(content: AvatarVideoContent, signal: AbortSignal,
  ports: DecoderPorts = nativePorts): Promise<SequenceFrameDecoder> {
  signal.throwIfAborted();
  const video = ports.video(), controller = new AbortController();
  let closed = false, busy = false, url: string | undefined;
  const close = () => {
    if (closed) return; closed = true;
    signal.removeEventListener("abort", close); controller.abort();
    release(() => video.pause()); release(() => video.removeAttribute("src")); release(() => video.load());
    if (url !== undefined) { const owned = url; url = undefined; release(() => ports.revokeUrl(owned)); }
  };
  signal.addEventListener("abort", close, { once: true });
  const current = () => {
    controller.signal.throwIfAborted();
    if (closed || video.error || video.readyState < 2 || video.videoWidth !== 256 || video.videoHeight !== 256
      || !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 10.1
      || Math.abs(video.duration - content.frames / AVATAR_SEQUENCE_FPS) > .1
      || !video.muted || video.volume !== 0 || !video.paused || video.loop || video.playbackRate !== 1
      || video.src !== url) throw new Error("meet_avatar_sequence_decoder_metadata_invalid");
  };
  try {
    if (content.repeatMode !== "hold_last") throw new Error("meet_avatar_sequence_decoder_content_invalid");
    video.muted = video.defaultMuted = true; video.volume = 0; video.playsInline = true;
    video.preload = "auto"; video.loop = false; video.playbackRate = 1;
    url = ports.createUrl(new Blob([content.bytes], { type: "video/mp4" })); video.src = url;
    if (video.readyState < 2) await videoEvent(video, "loadeddata", controller.signal, () => video.load());
    current();
    return { close, frame: async (index, caller) => {
      caller.throwIfAborted(); current();
      if (busy || !Number.isSafeInteger(index) || index < 0 || index >= content.frames) {
        throw new Error("meet_avatar_sequence_decoder_frame_invalid");
      }
      busy = true;
      const stop = () => close(); caller.addEventListener("abort", stop, { once: true });
      try {
        const target = (index + .5) / AVATAR_SEQUENCE_FPS;
        if (Math.abs(video.currentTime - target) > .0001) {
          await videoEvent(video, "seeked", controller.signal, () => { video.currentTime = target; });
        }
        current();
        if (!Number.isFinite(video.currentTime) || Math.abs(video.currentTime - target) > .0001) {
          throw new Error("meet_avatar_sequence_decoder_position_invalid");
        }
        // This Promise retains the preparation permit until a late bitmap is
        // owned/disposed; cancellation never starts an overlapping decoder.
        const bitmap = await ports.bitmap(video);
        let disposed = false;
        const dispose = () => { if (!disposed) { disposed = true; release(() => bitmap.close()); } };
        try {
          current(); caller.throwIfAborted();
          if (bitmap.width !== 256 || bitmap.height !== 256) throw new Error("meet_avatar_sequence_bitmap_invalid");
        } catch (error) { dispose(); throw error; }
        return { draw: drawing => {
          if (disposed) throw new Error("meet_avatar_sequence_bitmap_closed");
          drawing.drawImage(bitmap, 64, 40, 128, 128);
        }, close: dispose } satisfies PreparedAvatarFrame;
      } catch (error) { close(); throw error; }
      finally { caller.removeEventListener("abort", stop); busy = false; }
    } };
  } catch (error) { close(); throw error; }
}
