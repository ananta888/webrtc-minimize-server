import { AvatarVideoContent } from "./machine-avatar-video-contract";

export interface AvatarVideoDecoder {
  /** Holds the single decoder permit even after close until native play settles. */
  settled: Promise<void>;
  ready(): boolean;
  draw(drawing: CanvasRenderingContext2D): void;
  close(): void;
}

/** One owned, muted blob decoder. No remote URL, media capture or audio output. */
export function decodeAvatarVideo(content: AvatarVideoContent): AvatarVideoDecoder {
  const video = document.createElement("video");
  let url: string | undefined, closed = false, failed = false;
  const release = (action: () => void) => { try { action(); } catch { /* Continue releasing only owned resources. */ } };
  const close = () => {
    if (closed) return; closed = true;
    release(() => video.pause()); release(() => video.removeAttribute("src")); release(() => video.load());
    if (url !== undefined) { const owned = url; url = undefined; release(() => URL.revokeObjectURL(owned)); }
  };
  const ready = () => {
    if (closed || failed || video.error) throw new Error("meet_avatar_video_decoder_failed");
    if (video.readyState < 2) return false;
    if (video.videoWidth !== 256 || video.videoHeight !== 256 || !Number.isFinite(video.duration)
      || video.duration <= 0 || video.duration > 10.1 || Math.abs(video.duration - content.frames / 12) > 0.1
      || !video.muted || video.volume !== 0 || video.playbackRate !== 1 || video.src !== url
      || video.loop !== (content.repeatMode === "loop")) throw new Error("meet_avatar_video_metadata_invalid");
    return true;
  };
  try {
    video.muted = video.defaultMuted = true; video.volume = 0; video.playsInline = true;
    video.preload = "auto"; video.loop = content.repeatMode === "loop"; video.playbackRate = 1;
    url = URL.createObjectURL(new Blob([content.bytes], { type: "video/mp4" })); video.src = url;
    const pending = video.play();
    const settled = Promise.resolve(pending).then(() => { if (closed) release(() => video.pause()); }, () => { failed = true; close(); });
    return { settled, ready, draw: drawing => {
      if (!ready()) throw new Error("meet_avatar_video_not_ready");
      drawing.drawImage(video, 64, 40, 128, 128);
    }, close };
  } catch (error) { close(); throw error; }
}
