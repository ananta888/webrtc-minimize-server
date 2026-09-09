import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineVisualSessionService } from "./machine-visual-session.service";
import { VISUAL_LIMITS, VisualPixels } from "./machine-visual-surface";

const now = 1_788_000_000_000, own = "2".repeat(16), human = "1".repeat(16);
function setup() {
  let allowed = true;
  const source = { track: {}, peerId: human, source: "camera", publicationEpoch: 3 };
  const lease = signal({ sessionId: "ms_" + "a".repeat(32), generation: 1, expiresAt: now + 60_000 });
  const context = { tenantId: "tenant", projectId: "project", taskId: "task", runtimeId: "runtime", hubSessionId: "session" };
  const session = { joined: signal(true), roomId: signal("room-aaaaaaaaaaaaaaaaaa"), machineContext: () => context, machineLease: lease };
  const grants = signal([{ machinePeerId: own, publisherPeerId: human, publicationIds: ["camera"], expiresAt: now + 60_000 }]);
  const mesh = { ownPeerId: () => own, membershipEpoch: signal(1), machineReceive: { revision: signal(1), grants },
    remoteMedia: () => [{ key: "camera" }],
    machineVisualSource: () => { if (!allowed) throw new Error("denied"); return { ...source }; } };
  const pixels = () => ({ width: 640, height: 360, bytes: new Uint8Array([255, 216, 1, 255, 217]) });
  const surface = { frame: vi.fn(async () => pixels()), close: vi.fn() };
  const surfaces = { supported: () => true, connect: vi.fn(async () => surface) };
  const service = new MachineVisualSessionService(session as never, mesh as never, surfaces as never);
  return { service, session, mesh, context, grants, lease, source, surface, surfaces, pixels, deny: () => { allowed = false; } };
}
describe("bounded source-authorized visual session", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("probes without opening and lists only currently authorized visual sources", () => {
    const f = setup(); expect(f.service.probe()).toEqual({ schema: "ananta.meet-visual-probe.v1", profile: "jpeg-source-v1", supported: true, limits: VISUAL_LIMITS });
    expect(f.service.sources()[0]).toEqual({ publicationId: "camera", peerId: human, source: "camera", publicationEpoch: 3 });
    f.deny(); expect(f.service.sources()).toEqual([]); expect(f.surfaces.connect).not.toHaveBeenCalled();
  });
  it("binds the actual epoch, lease and scope; caps three frames and wipes encoded input", async () => {
    const f = setup(), sub = await f.service.open("camera"), pixels = f.pixels();
    expect(sub.binding).toMatchObject({ publication_epoch: 3, publication_id: "camera", receive_revision: 1,
      source: "camera", generation: 1, task_id: "task", deadline_ms: now + 60_000 });
    f.surface.frame.mockResolvedValueOnce(pixels);
    expect(await f.service.frame(sub.subscriptionId)).toMatchObject({ sequence: 1, width: 640, height: 360, jpegBase64: "/9gB/9k=" });
    expect(pixels.bytes.every(byte => byte === 0)).toBe(true);
    await expect(f.service.frame(sub.subscriptionId)).rejects.toThrow("meet_visual_frame_denied");
    for (let i = 2; i <= 3; i++) { vi.advanceTimersByTime(500); expect(await f.service.frame(sub.subscriptionId)).toMatchObject({ sequence: i }); }
    expect(f.surface.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500); await expect(f.service.frame(sub.subscriptionId)).rejects.toThrow();
    expect(f.surface.frame).toHaveBeenCalledTimes(3); f.service.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["grant", "source", "epoch", "track", "revision", "membership", "generation", "lease", "room", "scope", "leave", "clock", "deadline"])(
    "closes on %s mutation before another pixel export", async kind => {
      const f = setup(), sub = await f.service.open("camera");
      if (kind === "grant") f.grants.set([]);
      if (kind === "source") f.deny();
      if (kind === "epoch") f.source.publicationEpoch++;
      if (kind === "track") f.source.track = {};
      if (kind === "revision") f.mesh.machineReceive.revision.set(2);
      if (kind === "membership") f.mesh.membershipEpoch.set(2);
      if (kind === "generation") f.lease.update(v => ({ ...v, generation: 2 }));
      if (kind === "lease") f.lease.update(v => ({ ...v, sessionId: "other" }));
      if (kind === "room") f.session.roomId.set("room-bbbbbbbbbbbbbbbbbb");
      if (kind === "scope") f.context.taskId = "other";
      if (kind === "leave") f.session.joined.set(false);
      if (kind === "clock") vi.setSystemTime(now - 1);
      if (kind === "deadline") vi.setSystemTime(now + VISUAL_LIMITS.lifetimeMs);
      await expect(f.service.frame(sub.subscriptionId)).rejects.toThrow();
      expect(f.surface.frame).not.toHaveBeenCalled(); expect(f.service.status().open).toBe(false);
      expect(f.surface.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });
  it("does not open without current authority and aborts the decoder on timer-based revoke", async () => {
    const f = setup(); f.deny(); await expect(f.service.open("camera")).rejects.toThrow();
    expect(f.surfaces.connect).not.toHaveBeenCalled();
    const g = setup(); await g.service.open("camera"); g.deny(); vi.advanceTimersByTime(100);
    expect(g.service.status().open).toBe(false); expect(g.surface.close).toHaveBeenCalledOnce();
  });
  it("bounds a hanging setup and disposes a late decoder", async () => {
    const f = setup(); let resolve!: (value: typeof f.surface) => void;
    f.surfaces.connect.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = expect(f.service.open("camera")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(VISUAL_LIMITS.operationMs); await pending;
    resolve(f.surface); await Promise.resolve(); expect(f.surface.close).toHaveBeenCalledOnce();
    expect(f.service.status().open).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["revoked", "reopened", "timeout"])("discards a late frame after %s and fences a newer subscription", async kind => {
    const f = setup(), sub = await f.service.open("camera"); let resolve!: (value: VisualPixels) => void;
    f.surface.frame.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = expect(f.service.frame(sub.subscriptionId)).rejects.toThrow();
    await expect(f.service.frame(sub.subscriptionId)).rejects.toThrow("meet_visual_frame_denied");
    if (kind === "revoked") { f.deny(); await vi.advanceTimersByTimeAsync(100); }
    if (kind === "reopened") await f.service.open("camera");
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(VISUAL_LIMITS.operationMs);
    await pending; const pixels = f.pixels(); resolve(pixels); await Promise.resolve();
    expect(pixels.bytes.every(byte => byte === 0)).toBe(true);
    expect(f.service.status().open).toBe(kind === "reopened"); f.service.close();
  });
  it.each(["width", "height", "bytes", "fraction"])("fails closed on malformed %s returned by the decoder", async kind => {
    const f = setup(), sub = await f.service.open("camera"), pixels = f.pixels();
    if (kind === "width") pixels.width = 641;
    if (kind === "height") pixels.height = 361;
    if (kind === "fraction") pixels.width = 2.5;
    if (kind === "bytes") pixels.bytes = new Uint8Array(VISUAL_LIMITS.bytes + 1).fill(42);
    f.surface.frame.mockResolvedValue(pixels); await expect(f.service.frame(sub.subscriptionId)).rejects.toThrow();
    expect(pixels.bytes.every(byte => byte === 0)).toBe(true); expect(f.service.status().open).toBe(false);
  });
});
