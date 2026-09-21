import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineAvatarSessionService } from "./machine-avatar-session.service";
import { MachineMediaTimingService } from "./machine-media-timing.service";

function setup() {
  const drawing = { fillStyle: "", textAlign: "", font: "", fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn() };
  const track = { kind: "video", readyState: "live", requestFrame: vi.fn(), stop: vi.fn(), contentHint: "" };
  const stream = { getTracks: () => [track] };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => drawing), captureStream: vi.fn(() => stream) };
  const create = vi.spyOn(document, "createElement").mockReturnValue(canvas as never);
  const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn(), localPublicationProtected: vi.fn(() => true), overlayReady: () => true };
  const ownership = new MachinePublicationOwnership();
  const timing = new MachineMediaTimingService({ joined: () => true, machineLease: () => ({ sessionId: "owned" }) } as never);
  return { canvas, drawing, track, mesh, create, ownership, timing, factory: new MachineAvatarSurfaceFactory(mesh as never, ownership, timing) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("neutral synthetic canvas adapter", () => {
  it("records frame submission only and preserves decoded timing failures through owned cleanup", () => {
    const f = setup(); f.timing.start("independent-owned-live-v1");
    try {
      const canvas = f.factory.create(); canvas.frame(1);
      expect(f.timing.snapshot().sources.avatar).toMatchObject({ measurement: "canvas-submission", position_us: null, drift_us: null });
      canvas.close();
      const position = vi.fn(() => ({ positionUs: 500_000, held: false }));
      const video = f.factory.create({ draw: vi.fn(), close: vi.fn(), mediaTiming: position }); video.frame(1);
      expect(f.timing.snapshot().sources.avatar).toMatchObject({ measurement: "decoded-video", position_us: 500_000 });
      position.mockImplementation(() => { throw new Error("frame_clock_failed"); });
      expect(() => video.ready()).toThrow("frame_clock_failed");
      expect(f.timing.snapshot().sources.avatar!.state).toBe("failed");
      // The camera publication was handed over, never re-attached, and is parked again after the failure.
      expect(f.mesh.attachPublication).toHaveBeenCalledOnce(); expect(f.track.stop).not.toHaveBeenCalled();
    } finally { f.timing.close(); }
  });
  it("hands the live camera over to the next generation instead of detaching and re-attaching", () => {
    vi.useFakeTimers(); const f = setup(), first = f.factory.create(); first.close();
    expect(f.mesh.detachPublication).not.toHaveBeenCalled(); expect(f.track.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    const artwork = { draw: vi.fn(), close: vi.fn() }, second = f.factory.create(artwork);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.mesh.attachPublication).toHaveBeenCalledOnce();
    expect(artwork.draw).toHaveBeenCalledWith(f.drawing); expect(second.ready()).toBe(true);
    second.frame(3); expect(f.track.requestFrame).toHaveBeenCalledTimes(1);
    expect(() => first.frame(4)).toThrow("meet_avatar_not_ready"); expect(first.ready()).toBe(false);
    second.close(); vi.advanceTimersByTime(500);
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("camera"); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.canvas.width).toBe(0); expect(f.ownership.claim(["camera"]).owns("camera")).toBe(true);
  });
  it("keeps a parked camera only while a successor holds it, bounded by a fixed ceiling", () => {
    vi.useFakeTimers(); const f = setup();
    f.factory.create().close(); const release = f.factory.hold(); vi.advanceTimersByTime(2000);
    expect(f.mesh.detachPublication).not.toHaveBeenCalled();
    const next = f.factory.create(); expect(f.mesh.attachPublication).toHaveBeenCalledOnce(); release(); release();
    expect(next.ready()).toBe(true); next.close();
    const stalled = f.factory.hold(); vi.advanceTimersByTime(9_999); expect(f.mesh.detachPublication).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(f.mesh.detachPublication).toHaveBeenCalledOnce(); stalled();
    f.factory.create().close(); const late = f.factory.hold(); vi.advanceTimersByTime(600); late();
    expect(f.mesh.detachPublication).toHaveBeenCalledTimes(2); expect(f.track.stop).toHaveBeenCalledTimes(2);
  });
  it("yields a parked camera to an unrelated MP4 claimant unless a successor avatar is loading", () => {
    vi.useFakeTimers(); const f = setup(); f.factory.create().close();
    const release = f.factory.hold();
    expect(() => f.ownership.claim(["camera", "microphone"])).toThrow("meet_machine_publication_busy_or_invalid");
    release(); const mp4 = f.ownership.claim(["camera", "microphone"]);
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("camera"); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(() => f.factory.create()).toThrow("meet_machine_publication_busy_or_invalid"); mp4.release();
    const fresh = f.factory.create(); expect(f.mesh.attachPublication).toHaveBeenCalledTimes(2); fresh.close();
    vi.advanceTimersByTime(500); expect(f.mesh.detachPublication).toHaveBeenCalledTimes(2);
  });
  it("never adopts an ended parked track and discards it on the next generation", () => {
    vi.useFakeTimers(); const f = setup(); f.factory.create().close(); f.track.readyState = "ended";
    const stream2 = { getTracks: () => [{ kind: "video", readyState: "live", requestFrame: vi.fn(), stop: vi.fn(), contentHint: "" }] };
    f.canvas.captureStream.mockReturnValue(stream2 as never);
    const fresh = f.factory.create();
    expect(f.mesh.detachPublication).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.mesh.attachPublication).toHaveBeenCalledTimes(2); expect(fresh.ready()).toBe(true); fresh.close();
  });
  it("renders optional bounded artwork before immutable labels and releases its bitmap", () => {
    const f = setup(), artwork = { draw: vi.fn(), close: vi.fn() }, source = f.factory.create(artwork);
    expect(artwork.draw).toHaveBeenCalledWith(f.drawing);
    expect(f.drawing.arc).not.toHaveBeenCalled();
    expect(artwork.draw.mock.invocationCallOrder[0]).toBeLessThan(f.drawing.fillText.mock.invocationCallOrder[0]);
    expect(f.drawing.fillText).toHaveBeenCalledWith("KI", 128, 211);
    source.frame(1); expect(artwork.draw).toHaveBeenCalledTimes(2);
    source.close(); source.close(); expect(artwork.close).toHaveBeenCalledOnce();
  });
  it("owns only a labeled 256px canvas camera alongside an independently held microphone", () => {
    vi.useFakeTimers(); const f = setup(), mic = f.ownership.claim(["microphone"]), surface = f.factory.create();
    expect(f.create).toHaveBeenCalledExactlyOnceWith("canvas"); expect(f.canvas.width).toBe(256);
    expect(f.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.drawing.fillText).toHaveBeenCalledWith("ANANTA", 128, 30);
    expect(f.drawing.fillText).toHaveBeenCalledWith("KI", 128, 211);
    expect(f.mesh.attachPublication).toHaveBeenCalledWith("camera", expect.anything());
    expect(surface.ready()).toBe(true); expect(f.mesh.localPublicationProtected).toHaveBeenCalledWith(f.track);
    surface.frame(1); expect(f.track.requestFrame).toHaveBeenCalledOnce();
    surface.close(); surface.close(); vi.advanceTimersByTime(500); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("camera"); expect(f.canvas.width).toBe(0);
    expect(mic.owns("microphone")).toBe(true); mic.release();
  });
  it("cannot steal MP4 ownership and MP4 cannot steal an active camera", () => {
    const f = setup(), mp4 = f.ownership.claim(["camera", "microphone"]);
    expect(() => f.factory.create()).toThrow("meet_machine_publication_busy_or_invalid");
    expect(f.create).not.toHaveBeenCalled(); expect(f.mesh.detachPublication).not.toHaveBeenCalled(); mp4.release();
    const source = f.factory.create();
    expect(() => f.ownership.claim(["camera", "microphone"])).toThrow();
    expect(f.ownership.claim(["microphone"]).owns("microphone")).toBe(true); source.close();
  });
  it("checks the concrete camera protection on every frame, including ended tracks", () => {
    const f = setup(), source = f.factory.create(); f.mesh.localPublicationProtected.mockReturnValue(false);
    expect(source.ready()).toBe(false); expect(() => source.frame(1)).toThrow("meet_avatar_not_ready");
    f.mesh.localPublicationProtected.mockReturnValue(true); f.track.readyState = "ended";
    expect(() => source.frame(1)).toThrow(); expect(f.track.requestFrame).not.toHaveBeenCalled(); source.close();
  });
  it("releases a partial attachment and tolerates individual cleanup failures", () => {
    const f = setup(); f.mesh.attachPublication.mockImplementation(() => { throw new Error("attach failed"); });
    f.track.stop.mockImplementation(() => { throw new Error("stop failed"); });
    f.mesh.detachPublication.mockImplementation(() => { throw new Error("detach failed"); });
    expect(() => f.factory.create()).toThrow("attach failed"); expect(f.canvas.width).toBe(0);
    expect(f.ownership.claim(["camera"]).owns("camera")).toBe(true);
  });
  it("late cleanup cannot detach the next owner and unsupported browsers release claims", () => {
    vi.useFakeTimers(); const f = setup(), old = f.factory.create(); old.close();
    const fresh = f.factory.create(); old.close(); expect(f.mesh.detachPublication).not.toHaveBeenCalled();
    expect(fresh.ready()).toBe(true); fresh.close(); vi.advanceTimersByTime(500);
    expect(f.mesh.detachPublication).toHaveBeenCalledOnce();
    f.canvas.getContext.mockReturnValue(null as never);
    expect(() => f.factory.create()).toThrow("meet_avatar_unsupported");
    expect(f.ownership.claim(["camera"]).owns("camera")).toBe(true);
  });
  it("projects only verified session, membership and avatar capability", async () => {
    let joined = false, allowed = false;
    const session = { joined: () => joined, machineContext: () => ({ hubSessionId: "hub" }),
      machineLease: () => ({ sessionId: "ms_test", generation: 1, expiresAt: Date.now() + 60_000 }) };
    const mesh = { ownPeerId: () => "p_machine", membershipEpoch: () => 2,
      machineReceive: { supports: vi.fn(() => allowed) } };
    const surfaces = { create: vi.fn() };
    const service = new MachineAvatarSessionService(session as never, mesh as never, surfaces as never,
      new MachineMediaTimingService(session as never));
    await expect(service.source.open("avatar:hub", "neutral-ai-v1")).rejects.toThrow("meet_avatar_source_denied");
    joined = true; await expect(service.source.open("avatar:hub", "neutral-ai-v1")).rejects.toThrow();
    expect(mesh.machineReceive.supports).toHaveBeenCalledWith("p_machine", "avatar.publish");
    allowed = true; await expect(service.source.open("avatar:other", "neutral-ai-v1")).rejects.toThrow();
    expect(surfaces.create).not.toHaveBeenCalled(); service.ngOnDestroy();
  });
});
