import { describe, expect, it, vi } from "vitest";
import { MachineMediaTimeline } from "./machine-media-timeline";

function fixture() {
  let now = 1_000_000;
  const timeline = new MachineMediaTimeline(3, () => now);
  return { timeline, time: (value: number) => { now = value; } };
}

describe("membership-owned media timing", () => {
  it("projects exact closed independent source clocks and copied rows", () => {
    const f = fixture(), speech = f.timeline.open("speech", "pcm-progress", vi.fn());
    const screen = f.timeline.open("screen", "canvas-submission", vi.fn());
    expect(f.timeline.snapshot().sources).toEqual({});
    speech.observe(20_000); screen.observe(null);
    f.time(1_200_000); speech.observe(220_000); screen.observe(null);
    const snapshot = f.timeline.snapshot();
    expect(snapshot).toEqual({ schema: "ananta.meet-media-timing.v1", profile: "independent-owned-live-v1",
      timebase: "browser-performance-v1", epoch: 3, now_us: 1_200_000, sources: {
        speech: { generation: 1, state: "running", measurement: "pcm-progress", started_at_us: 1_000_000,
          position_at_us: 1_200_000, observed_at_us: 1_200_000, origin_position_us: 20_000, position_us: 220_000, drift_us: 0 },
        screen: { generation: 1, state: "running", measurement: "canvas-submission", started_at_us: 1_000_000,
          position_at_us: 1_200_000, observed_at_us: 1_200_000, origin_position_us: null, position_us: null, drift_us: null },
      } });
    snapshot.sources.speech!.generation = 99;
    expect(f.timeline.snapshot().sources.speech!.generation).toBe(1);
  });

  it("holds decoded media position while requiring fresh rendering observations", () => {
    const f = fixture(), source = f.timeline.open("avatar", "decoded-video", vi.fn());
    source.observe(100_000); f.time(1_200_000); source.observe(300_000, true);
    for (const now of [1_800_000, 2_400_000, 3_000_000]) { f.time(now); source.observe(300_000, true); }
    expect(f.timeline.snapshot().sources.avatar).toMatchObject({ state: "held", position_us: 300_000,
      position_at_us: 1_200_000, observed_at_us: 3_000_000, drift_us: 0 });
    expect(() => source.observe(300_000)).toThrow("position_invalid");
    expect(f.timeline.snapshot().sources.avatar!.state).toBe("failed");
  });

  it("retires callbacks without affecting replacements or independent sources", () => {
    const f = fixture(), oldStop = vi.fn(), freshStop = vi.fn(), screenStop = vi.fn();
    const old = f.timeline.open("speech", "pcm-progress", oldStop);
    const screen = f.timeline.open("screen", "canvas-submission", screenStop);
    old.observe(0); screen.observe(null); old.close();
    const fresh = f.timeline.open("speech", "pcm-progress", freshStop); fresh.observe(0);
    old.observe(Number.NaN); old.close();
    expect(f.timeline.snapshot().sources.speech!.generation).toBe(2);
    expect(oldStop).not.toHaveBeenCalled(); expect(freshStop).not.toHaveBeenCalled(); expect(screenStop).not.toHaveBeenCalled();
  });

  it.each([-500_001, 500_001])("fails excessive signed drift %s once and cannot hide it by closing", drift => {
    const f = fixture(), stop = vi.fn(), source = f.timeline.open("speech", "pcm-progress", stop);
    source.observe(0); f.time(1_600_000);
    expect(() => source.observe(600_000 + drift)).toThrow("drift_exceeded");
    source.close(); source.observe(600_000);
    expect(stop).toHaveBeenCalledOnce(); expect(f.timeline.snapshot().sources.speech!.state).toBe("failed");
    expect(() => f.timeline.open("speech", "pcm-progress", vi.fn())).toThrow("busy");
  });

  it.each([-500_000, 500_000])("accepts the exact signed drift boundary %s", drift => {
    const f = fixture(), source = f.timeline.open("speech", "pcm-progress", vi.fn());
    source.observe(0); f.time(1_600_000); source.observe(600_000 + drift);
    expect(f.timeline.snapshot().sources.speech!.drift_us).toBe(drift);
  });

  it("fails source age on snapshot, even when owned cleanup throws", () => {
    const f = fixture(), stop = vi.fn(() => { throw new Error("owned cleanup"); });
    f.timeline.open("screen", "canvas-submission", stop).observe(null);
    f.time(1_750_000); expect(f.timeline.snapshot().sources.screen!.state).toBe("running");
    f.time(1_750_001); expect(f.timeline.snapshot().sources.screen!.state).toBe("failed");
    f.timeline.snapshot(); expect(stop).toHaveBeenCalledOnce();
  });

  it("cannot revive a stale source with a fresh callback", () => {
    const f = fixture(), source = f.timeline.open("screen", "canvas-submission", vi.fn());
    source.observe(null); f.time(1_750_001);
    expect(() => source.observe(null)).toThrow("stale");
  });

  it.each([999_999, Number.NaN, Number.POSITIVE_INFINITY, 1.2, 86_400_000_001])("irreversibly rejects bad clock %s", now => {
    const f = fixture(), stop = vi.fn(); f.timeline.open("screen", "canvas-submission", stop).observe(null);
    f.time(now); expect(() => f.timeline.snapshot()).toThrow("clock_invalid");
    f.time(2_000_000); expect(() => f.timeline.snapshot()).toThrow("closed"); expect(stop).toHaveBeenCalledOnce();
  });

  it.each([null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid PCM position %s", position => {
    const f = fixture(), stop = vi.fn(), source = f.timeline.open("speech", "pcm-progress", stop);
    expect(() => source.observe(position)).toThrow("observation_invalid"); expect(stop).toHaveBeenCalledOnce();
    source.close(); source.observe(0);
    expect(() => f.timeline.snapshot()).toThrow("source_failed");
    expect(() => f.timeline.open("speech", "pcm-progress", vi.fn())).toThrow("busy");
  });

  it("rejects regression, canvas media positions and held PCM", () => {
    const f = fixture(), speech = f.timeline.open("speech", "pcm-progress", vi.fn());
    speech.observe(100); expect(() => speech.observe(99)).toThrow("position_invalid");
    const screen = f.timeline.open("screen", "canvas-submission", vi.fn());
    expect(() => screen.observe(0)).toThrow("observation_invalid");
    const g = fixture(); expect(() => g.timeline.open("speech", "pcm-progress", vi.fn()).observe(0, true)).toThrow("observation_invalid");
  });

  it("bounds epochs, kinds, generations and closes all owners independently", () => {
    for (const epoch of [0, 4097, -1, 1.1, Number.NaN]) expect(() => new MachineMediaTimeline(epoch, () => 0)).toThrow("epoch_invalid");
    const f = fixture();
    expect(() => f.timeline.open("__proto__" as never, "canvas-submission", vi.fn())).toThrow("source_invalid");
    expect(() => f.timeline.open("screen", "decoded-video", vi.fn())).toThrow("source_invalid");
    for (let count = 0; count < 4096; count++) f.timeline.open("speech", "pcm-progress", vi.fn()).close();
    expect(() => f.timeline.open("speech", "pcm-progress", vi.fn())).toThrow("generation_exhausted");
    const first = vi.fn(() => { throw new Error("cleanup"); }), second = vi.fn();
    f.timeline.open("avatar", "decoded-video", first); f.timeline.open("screen", "canvas-submission", second);
    f.timeline.close(); f.timeline.close(); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  });
});
