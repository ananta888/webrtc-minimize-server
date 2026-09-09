import { Injectable } from "@angular/core";

export const VISUAL_LIMITS = Object.freeze({ width: 640, height: 360, bytes: 98_304,
  frames: 3, intervalMs: 500, lifetimeMs: 10_000, operationMs: 2_000 });
export interface VisualPixels { readonly width: number; readonly height: number; readonly bytes: Uint8Array }
export interface MachineVisualSurface { frame(): Promise<VisualPixels>; close(): void }

/** Decodes only the supplied remote track; owns its clone, never the mesh track. */
@Injectable({ providedIn: "root" })
export class MachineVisualSurfaceFactory {
  supported(): boolean {
    return typeof document !== "undefined" && typeof MediaStream !== "undefined"
      && typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.toBlob === "function";
  }
  async connect(track: MediaStreamTrack, signal: AbortSignal): Promise<MachineVisualSurface> {
    signal.throwIfAborted();
    if (!this.supported() || track.kind !== "video" || track.readyState !== "live" || track.muted || !track.enabled) {
      throw new Error("meet_visual_source_unavailable");
    }
    const clone = track.clone();
    let video: HTMLVideoElement | null = null, canvas: HTMLCanvasElement | null = null;
    let closed = false, busy = false;
    const release = (action: () => void) => { try { action(); } catch { /* Release remaining owned resources. */ } };
    const close = () => {
      if (closed) return; closed = true; signal.removeEventListener("abort", close);
      release(() => video?.pause()); release(() => { if (video) video.srcObject = null; });
      release(() => video?.removeAttribute("src")); release(() => video?.load());
      release(() => clone.stop()); release(() => { if (canvas) canvas.width = canvas.height = 0; });
    };
    const check = () => { if (closed || signal.aborted) throw new Error("meet_visual_cancelled"); };
    signal.addEventListener("abort", close, { once: true });
    try {
      video = document.createElement("video"); canvas = document.createElement("canvas");
      video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([clone]);
      await video.play(); check();
      return { close, frame: async () => {
        check();
        if (busy) throw new Error("meet_visual_busy");
        busy = true;
        let bytes: Uint8Array | null = null;
        try {
          const originalWidth = video!.videoWidth, originalHeight = video!.videoHeight;
          if (video!.readyState < 2 || originalWidth < 1 || originalHeight < 1
            || originalWidth * originalHeight > 20_000_000) throw new Error("meet_visual_frame_unavailable");
          const scale = Math.min(1, VISUAL_LIMITS.width / originalWidth, VISUAL_LIMITS.height / originalHeight);
          const width = Math.max(1, Math.floor(originalWidth * scale)), height = Math.max(1, Math.floor(originalHeight * scale));
          canvas!.width = width; canvas!.height = height;
          const context = canvas!.getContext("2d", { alpha: false });
          if (!context) throw new Error("meet_visual_canvas_unavailable");
          context.drawImage(video!, 0, 0, width, height);
          const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, "image/jpeg", 0.65));
          check();
          if (!blob || blob.type !== "image/jpeg" || blob.size < 1 || blob.size > VISUAL_LIMITS.bytes) throw new Error("meet_visual_frame_size");
          bytes = new Uint8Array(await blob.arrayBuffer()); check();
          const result = { width, height, bytes }; bytes = null; return result;
        } finally { bytes?.fill(0); if (canvas) canvas.width = canvas.height = 0; busy = false; }
      } };
    } catch (error) { close(); throw error; }
  }
}
