import { afterEach, expect, it, vi } from "vitest";
import { MachineVisualSurfaceFactory, VISUAL_LIMITS } from "./machine-visual-surface";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 2, muted: false, playsInline: false,
    srcObject: null as unknown, play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const blob = { type: "image/jpeg", size: bytes.length, arrayBuffer: vi.fn(async () => bytes.buffer) };
  const context = { drawImage: vi.fn() }, canvas = { width: 0, height: 0, getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: (value: unknown) => void) => callback(blob)) };
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => (tag === "video" ? video : canvas) as never);
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
  const clone = { stop: vi.fn() }, track = { kind: "video", readyState: "live", muted: false, enabled: true,
    clone: vi.fn(() => clone), stop: vi.fn() };
  const factory = new MachineVisualSurfaceFactory(), controller = new AbortController();
  return { video, bytes, blob, context, canvas, clone, track, factory, controller };
}
it("samples bounded JPEG pixels from a silent owned clone and wipes the canvas", async () => {
  const f = setup(), surface = await f.factory.connect(f.track as never, f.controller.signal);
  const frame = await surface.frame();
  expect(frame).toEqual({ width: 640, height: 360, bytes: f.bytes });
  expect(f.video.muted).toBe(true); expect(f.video.playsInline).toBe(true);
  expect(f.context.drawImage).toHaveBeenCalledWith(f.video, 0, 0, 640, 360);
  expect(f.canvas.width).toBe(0); expect(f.canvas.height).toBe(0);
  surface.close(); surface.close(); expect(f.clone.stop).toHaveBeenCalledOnce();
  expect(f.track.stop).not.toHaveBeenCalled(); expect(f.video.srcObject).toBeNull();
});
it.each(["kind", "ended", "muted", "disabled", "aborted"])("denies %s before cloning a source", async kind => {
  const f = setup();
  if (kind === "kind") f.track.kind = "audio";
  if (kind === "ended") f.track.readyState = "ended";
  if (kind === "muted") f.track.muted = true;
  if (kind === "disabled") f.track.enabled = false;
  if (kind === "aborted") f.controller.abort();
  await expect(f.factory.connect(f.track as never, f.controller.signal)).rejects.toThrow();
  expect(f.track.clone).not.toHaveBeenCalled();
});
it.each(["element", "play"])("releases a clone when %s setup fails", async kind => {
  const f = setup();
  if (kind === "element") vi.spyOn(document, "createElement").mockImplementation(() => { throw new Error("denied"); });
  else f.video.play.mockRejectedValue(new Error("denied"));
  await expect(f.factory.connect(f.track as never, f.controller.signal)).rejects.toThrow();
  expect(f.clone.stop).toHaveBeenCalledOnce(); expect(f.track.stop).not.toHaveBeenCalled();
});
it.each(["unready", "zero", "pixels", "bytes", "format"])("rejects %s decoding without exporting a frame", async kind => {
  const f = setup(), surface = await f.factory.connect(f.track as never, f.controller.signal);
  if (kind === "unready") f.video.readyState = 1;
  if (kind === "zero") f.video.videoWidth = 0;
  if (kind === "pixels") f.video.videoWidth = 100_000;
  if (kind === "bytes") f.blob.size = VISUAL_LIMITS.bytes + 1;
  if (kind === "format") f.blob.type = "image/png";
  await expect(surface.frame()).rejects.toThrow(); expect(f.blob.arrayBuffer).not.toHaveBeenCalled();
  expect(f.canvas.width).toBe(0); surface.close();
});
it("discards an encoding callback after abort and never reads its bytes", async () => {
  const f = setup(), surface = await f.factory.connect(f.track as never, f.controller.signal);
  let complete!: (blob: unknown) => void;
  f.canvas.toBlob.mockImplementation(callback => { complete = callback; });
  const pending = expect(surface.frame()).rejects.toThrow("meet_visual_cancelled");
  f.controller.abort(); complete(f.blob); await pending;
  expect(f.blob.arrayBuffer).not.toHaveBeenCalled(); expect(f.canvas.width).toBe(0);
  expect(f.clone.stop).toHaveBeenCalledOnce();
});
it("wipes bytes decoded after cancellation and continues cleanup if the video sink throws", async () => {
  const f = setup(), surface = await f.factory.connect(f.track as never, f.controller.signal);
  let complete!: (bytes: ArrayBuffer) => void;
  f.blob.arrayBuffer.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = expect(surface.frame()).rejects.toThrow("meet_visual_cancelled");
  await Promise.resolve(); await Promise.resolve();
  f.video.pause.mockImplementation(() => { throw new Error("sink failed"); });
  f.controller.abort(); complete(f.bytes.buffer); await pending;
  expect(f.bytes.every(byte => byte === 0)).toBe(true); expect(f.clone.stop).toHaveBeenCalledOnce();
  expect(f.video.srcObject).toBeNull(); expect(f.canvas.width).toBe(0);
});
