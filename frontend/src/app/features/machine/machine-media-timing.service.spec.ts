import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineMediaTimingService } from "./machine-media-timing.service";
import { MEDIA_TIMING_PROFILE } from "./machine-media-timeline";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  vi.useFakeTimers();
  let id = "owned-session", joined = true;
  const service = new MachineMediaTimingService({ joined: () => joined,
    machineLease: () => ({ sessionId: id }) } as never);
  return { service, depart: () => { joined = false; }, replace: () => { id = "replacement"; } };
}
describe("optional machine media timing composition", () => {
  it("keeps legacy sources unobserved and denies mid-flight activation", () => {
    const f = fixture(), stop = vi.fn(), lease = f.service.open("speech", "pcm-progress", stop);
    lease.observe(Number.NaN); expect(stop).not.toHaveBeenCalled();
    expect(() => f.service.start(MEDIA_TIMING_PROFILE)).toThrow("start_denied");
    expect(() => f.service.snapshot()).toThrow("disabled");
    lease.close(); expect(f.service.start(MEDIA_TIMING_PROFILE).sources).toEqual({});
    f.service.close();
  });
  it("exposes the exact additive probe with no membership calls", () => {
    const session = { joined: vi.fn(), machineLease: vi.fn() };
    const service = new MachineMediaTimingService(session as never);
    expect(service.probe()).toEqual({ schema: "ananta.meet-media-timing-probe.v1", profile: MEDIA_TIMING_PROFILE,
      timebase: "browser-performance-v1", max_drift_us: 500_000, max_age_us: 750_000, decoded_video: false, canvas_submission: false });
    expect(Object.isFrozen(service.probe())).toBe(true); expect(session.joined).not.toHaveBeenCalled();
    expect(session.machineLease).not.toHaveBeenCalled();
  });
  it("cannot reset timing within a membership; leave creates a new independent epoch", () => {
    const f = fixture(); expect(f.service.start(MEDIA_TIMING_PROFILE).epoch).toBe(1);
    expect(() => f.service.start(MEDIA_TIMING_PROFILE)).toThrow("start_denied");
    const old = f.service.open("screen", "canvas-submission", vi.fn()); old.observe(null);
    f.service.close(); expect(f.service.start(MEDIA_TIMING_PROFILE).epoch).toBe(2);
    const fresh = f.service.open("screen", "canvas-submission", vi.fn()); fresh.observe(null);
    old.close(); old.observe(0); expect(f.service.snapshot().sources.screen!.state).toBe("running"); f.service.close();
  });
  it.each(["depart", "replace"] as const)("stops only its source owners after membership %s", action => {
    const f = fixture(), stop = vi.fn(); f.service.start(MEDIA_TIMING_PROFILE);
    f.service.open("screen", "canvas-submission", stop).observe(null);
    f[action](); vi.advanceTimersByTime(100); expect(stop).toHaveBeenCalledOnce();
    expect(() => f.service.snapshot()).toThrow("failed");
    expect(() => f.service.open("speech", "pcm-progress", vi.fn())).toThrow("failed"); f.service.close();
  });
  it("enforces age without external polling and retains failed rows", () => {
    const f = fixture(), stop = vi.fn();
    let now = 1000; vi.spyOn(performance, "now").mockImplementation(() => now);
    f.service.start(MEDIA_TIMING_PROFILE);
    const lease = f.service.open("screen", "canvas-submission", stop); lease.observe(null);
    now = 1800; vi.advanceTimersByTime(100); expect(stop).toHaveBeenCalledOnce();
    lease.close(); expect(f.service.snapshot().sources.screen!.state).toBe("failed"); f.service.close();
  });
  it("denies invalid profiles and absent membership", () => {
    const f = fixture();
    for (const profile of [null, {}, true, "other"]) expect(() => f.service.start(profile)).toThrow("start_denied");
    f.depart(); expect(() => f.service.start(MEDIA_TIMING_PROFILE)).toThrow("membership_invalid");
  });
});
