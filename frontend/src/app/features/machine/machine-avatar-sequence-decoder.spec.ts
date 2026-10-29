import { describe, expect, it, vi } from "vitest";
import { decodeAvatarSequenceClip } from "./machine-avatar-sequence-decoder";
import { parseAvatarVideo } from "./machine-avatar-video-contract";

class Video extends EventTarget {
  muted = false; defaultMuted = false; volume = 1; playsInline = false; preload = "";
  loop = false; playbackRate = 1; src = ""; readyState = 2; videoWidth = 256; videoHeight = 256;
  duration = 1; error = null; paused = true; autoSeek = true; autoLoad = true;
  private position = 0;
  get currentTime() { return this.position; }
  set currentTime(value: number) {
    this.position = value;
    if (this.autoSeek) queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ""; });
  load = vi.fn(() => {
    if (this.autoLoad && this.src) queueMicrotask(() => { this.readyState = 2; this.dispatchEvent(new Event("loadeddata")); });
  });
}
function fixture() {
  const video = new Video(), caller = new AbortController();
  const bitmap = { width: 256, height: 256, close: vi.fn() };
  const ports = { video: () => video as unknown as HTMLVideoElement,
    bitmap: vi.fn(async () => bitmap as unknown as ImageBitmap),
    createUrl: vi.fn(() => "blob:owned-sequence"), revokeUrl: vi.fn() };
  const content = parseAvatarVideo({ mp4: btoa("0000ftyp00000000"), sha256: "a".repeat(64), frames: 12,
    repeatMode: "hold_last", originKind: "generated", classification: "test_only" });
  return { video, caller, bitmap, ports, content };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("owned silent sequential frame decoder", () => {
  it("seeks to a frame midpoint without playback or capture and releases only owned resources", async () => {
    const f = fixture(), decoder = await decodeAvatarSequenceClip(f.content, f.caller.signal, f.ports);
    const frame = await decoder.frame(5, f.caller.signal);
    expect(f.video.currentTime).toBe(5.5 / 12); expect(f.video.play).not.toHaveBeenCalled();
    expect(f.video.muted).toBe(true); expect(f.video.volume).toBe(0);
    const drawing = { drawImage: vi.fn() };
    decoder.close(); decoder.close();
    frame.draw(drawing as never);
    expect(drawing.drawImage).toHaveBeenCalledExactlyOnceWith(f.bitmap, 64, 40, 128, 128);
    frame.close(); frame.close(); expect(f.bitmap.close).toHaveBeenCalledOnce();
    expect(f.ports.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:owned-sequence");
    expect(() => frame.draw(drawing as never)).toThrow("bitmap_closed");
  });
  it("loads metadata through bounded caller cancellation", async () => {
    const f = fixture(); f.video.readyState = 0;
    const decoder = await decodeAvatarSequenceClip(f.content, f.caller.signal, f.ports);
    expect(f.video.load).toHaveBeenCalledOnce(); decoder.close();
  });
  it.each([{ videoWidth: 2048 }, { duration: NaN }, { duration: 11 }, { paused: false }])(
    "rejects unsupported/malformed metadata %j before copying pixels", async patch => {
      const f = fixture(); Object.assign(f.video, patch);
      await expect(decodeAvatarSequenceClip(f.content, f.caller.signal, f.ports)).rejects.toThrow("metadata_invalid");
      expect(f.ports.bitmap).not.toHaveBeenCalled(); expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
    });
  it("cancels stalled load and seek without waiting for external input", async () => {
    const f = fixture(); f.video.readyState = 0; f.video.autoLoad = false;
    const pending = decodeAvatarSequenceClip(f.content, f.caller.signal, f.ports);
    const rejected = expect(pending).rejects.toThrow(); f.caller.abort(); await rejected;
    expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
    const g = fixture(), decoder = await decodeAvatarSequenceClip(g.content, g.caller.signal, g.ports);
    g.video.autoSeek = false;
    const frame = decoder.frame(2, g.caller.signal), cancelled = expect(frame).rejects.toThrow();
    g.caller.abort(); await cancelled; expect(g.ports.bitmap).not.toHaveBeenCalled();
  });
  it("holds in-flight bitmap work until its late result can be disposed and rejects overlap", async () => {
    const f = fixture(); let resolve!: (value: ImageBitmap) => void;
    f.ports.bitmap.mockImplementation(() => new Promise(r => { resolve = r; }));
    const decoder = await decodeAvatarSequenceClip(f.content, f.caller.signal, f.ports);
    const pending = decoder.frame(0, f.caller.signal), rejected = expect(pending).rejects.toThrow();
    await flush();
    await expect(decoder.frame(1, f.caller.signal)).rejects.toThrow("frame_invalid");
    f.caller.abort(); resolve(f.bitmap as unknown as ImageBitmap); await rejected;
    expect(f.bitmap.close).toHaveBeenCalledOnce(); expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
  });
  it("cleans an unexpected bitmap shape instead of exporting it", async () => {
    const f = fixture(); f.bitmap.width = 512;
    const decoder = await decodeAvatarSequenceClip(f.content, f.caller.signal, f.ports);
    await expect(decoder.frame(1, f.caller.signal)).rejects.toThrow("bitmap_invalid");
    expect(f.bitmap.close).toHaveBeenCalledOnce(); expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
  });
});
