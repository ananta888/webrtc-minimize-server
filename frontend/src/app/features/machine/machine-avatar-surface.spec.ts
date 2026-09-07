import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineAvatarSessionService } from "./machine-avatar-session.service";

function setup() {
  const drawing = { fillStyle: "", textAlign: "", font: "", fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn() };
  const track = { kind: "video", readyState: "live", requestFrame: vi.fn(), stop: vi.fn(), contentHint: "" };
  const stream = { getTracks: () => [track] };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => drawing), captureStream: vi.fn(() => stream) };
  const create = vi.spyOn(document, "createElement").mockReturnValue(canvas as never);
  const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn(), localPublicationProtected: vi.fn(() => true), overlayReady: () => true };
  const ownership = new MachinePublicationOwnership();
  return { canvas, drawing, track, mesh, create, ownership, factory: new MachineAvatarSurfaceFactory(mesh as never, ownership) };
}
afterEach(() => { vi.restoreAllMocks(); });
describe("neutral synthetic canvas adapter", () => {
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
    const f = setup(), mic = f.ownership.claim(["microphone"]), surface = f.factory.create();
    expect(f.create).toHaveBeenCalledExactlyOnceWith("canvas"); expect(f.canvas.width).toBe(256);
    expect(f.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.drawing.fillText).toHaveBeenCalledWith("ANANTA", 128, 30);
    expect(f.drawing.fillText).toHaveBeenCalledWith("KI", 128, 211);
    expect(f.mesh.attachPublication).toHaveBeenCalledWith("camera", expect.anything());
    expect(surface.ready()).toBe(true); expect(f.mesh.localPublicationProtected).toHaveBeenCalledWith(f.track);
    surface.frame(1); expect(f.track.requestFrame).toHaveBeenCalledOnce();
    surface.close(); surface.close(); expect(f.track.stop).toHaveBeenCalledOnce();
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
    const f = setup(), old = f.factory.create(); old.close();
    const fresh = f.factory.create(); old.close(); expect(f.mesh.detachPublication).toHaveBeenCalledOnce();
    expect(fresh.ready()).toBe(true); fresh.close();
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
    const service = new MachineAvatarSessionService(session as never, mesh as never, surfaces as never);
    await expect(service.source.open("avatar:hub", "neutral-ai-v1")).rejects.toThrow("meet_avatar_source_denied");
    joined = true; await expect(service.source.open("avatar:hub", "neutral-ai-v1")).rejects.toThrow();
    expect(mesh.machineReceive.supports).toHaveBeenCalledWith("p_machine", "avatar.publish");
    allowed = true; await expect(service.source.open("avatar:other", "neutral-ai-v1")).rejects.toThrow();
    expect(surfaces.create).not.toHaveBeenCalled(); service.ngOnDestroy();
  });
});
