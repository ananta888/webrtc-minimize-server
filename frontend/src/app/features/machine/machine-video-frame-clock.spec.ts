import { describe, expect, it, vi } from "vitest";
import { observeOwnedVideoFrames } from "./machine-video-frame-clock";

function fixture(loop = true) {
  let callback!: VideoFrameRequestCallback, now = 1_000_000, handle = 0;
  const video = { duration: 1, ended: false,
    requestVideoFrameCallback: vi.fn((next: VideoFrameRequestCallback) => { callback = next; return ++handle; }),
    cancelVideoFrameCallback: vi.fn() };
  const observer = observeOwnedVideoFrames(video as never, loop, () => now);
  const emit = (mediaTime: number, presentedFrames: number, at = now, extra = {}) => {
    now = at; callback(0, { mediaTime, presentedFrames, width: 256, height: 256, ...extra } as never);
  };
  return { observer, video, emit, callback: () => callback, time: (value: number) => { now = value; } };
}
describe("owned decoder compositor-frame clock", () => {
  it("waits for native metadata and unwraps only observed loops", () => {
    const f = fixture(); expect(f.observer.read()).toBeNull();
    f.emit(0.8, 10); expect(f.observer.read()).toEqual({ positionUs: 800_000, held: false });
    f.emit(0.9, 11, 1_100_000); f.emit(0, 12, 1_200_000);
    expect(f.observer.read()).toEqual({ positionUs: 1_000_000, held: false });
    const copy = f.observer.read()!; copy.positionUs = 0;
    expect(f.observer.read()!.positionUs).toBe(1_000_000); f.observer.close();
  });
  it("retains the final decoded frame for hold, without claiming new decoded frames", () => {
    const f = fixture(false); f.emit(0.9, 11); f.video.ended = true;
    f.time(8_000_000); expect(f.observer.read()).toEqual({ positionUs: 900_000, held: true }); f.observer.close();
  });
  it.each(["width", "position", "counter", "duration", "gap", "rollback"])("fails malformed or ambiguous %s without estimating progress", fault => {
    const f = fixture(); f.emit(0.8, 10);
    if (fault === "duration") f.video.duration = 2;
    f.emit(fault === "position" ? Number.NaN : 0.9, fault === "counter" ? 10 : 11,
      fault === "gap" ? 2_000_000 : fault === "rollback" ? 999_999 : 1_100_000,
      fault === "width" ? { width: 128 } : {});
    expect(() => f.observer.read()).toThrow("clock_failed");
    f.emit(0.95, 12, 1_200_000); expect(() => f.observer.read()).toThrow("clock_failed"); f.observer.close();
  });
  it("rejects backward PTS for a non-looping decoder", () => {
    const f = fixture(false); f.emit(0.8, 10); f.emit(0.1, 11, 1_100_000);
    expect(() => f.observer.read()).toThrow("clock_failed"); f.observer.close();
  });
  it("a running decoder needs a fresh callback, not a progressing currentTime guess", () => {
    const f = fixture(); f.emit(0, 1); f.time(1_750_001);
    expect(() => f.observer.read()).toThrow("clock_failed"); f.observer.close();
  });
  it("cancels only its outstanding callback and ignores a late native callback", () => {
    const f = fixture(), late = f.callback(); f.observer.close(); f.observer.close();
    expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledExactlyOnceWith(1);
    late(0, {} as never); expect(f.video.requestVideoFrameCallback).toHaveBeenCalledOnce();
    expect(() => f.observer.read()).toThrow("clock_failed");
  });
  it("does not silently claim support without the native API", () => {
    expect(() => observeOwnedVideoFrames({} as never, true)).toThrow("unsupported");
  });
});
