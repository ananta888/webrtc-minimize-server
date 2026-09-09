import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineAvatarSource } from "./machine-avatar-source";

const now = 1_788_000_000_000;
function setup() {
  const authority = { sourceId: "avatar:hub", sessionId: "ms_test", leaseGeneration: 1, membershipEpoch: 2, expiresAt: now + 60_000 };
  const surface = { ready: vi.fn(() => true), frame: vi.fn(), close: vi.fn() };
  const ports = { authority: vi.fn(() => authority), create: vi.fn(() => surface) };
  const source = new MachineAvatarSource(ports);
  return { source, authority, surface, ports, open: () => source.open("avatar:hub", "neutral-ai-v1") };
}
describe("independent bounded avatar lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("adds explicit image mode without silently accepting image bytes in neutral mode", async () => {
    const f = setup(), image = { png: "synthetic", sha256: "a".repeat(64) };
    await expect(f.source.open("avatar:hub", "neutral-ai-v1", image)).rejects.toThrow("source_denied");
    await expect(f.source.open("avatar:hub", "persona-image-v1")).rejects.toThrow("source_denied");
    expect(f.ports.create).not.toHaveBeenCalled();
    const receipt = await f.source.open("avatar:hub", "persona-image-v1", image);
    expect(receipt.profile).toBe("persona-image-v1");
    expect(f.ports.create).toHaveBeenCalledWith("persona-image-v1", image, expect.any(Function));
    f.source.close();
  });
  it("late asynchronous artwork check cannot borrow another source generation", async () => {
    const f = setup(); await f.open();
    const check = (f.ports.create.mock.calls[0] as unknown as [unknown, unknown, () => void])[2];
    f.source.close(); await f.open(); expect(() => check()).toThrow("generation_changed"); f.source.close();
  });

  it("requires the explicit closed profile and exact source before allocation", async () => {
    const f = setup();
    for (const [id, profile] of [["avatar:other", "neutral-ai-v1"], ["avatar:hub", ""], ["avatar:hub", "https://image"], ["avatar:hub", "persona"]]) {
      await expect(f.source.open(id, profile)).rejects.toThrow("meet_avatar_source_denied");
    }
    f.authority.expiresAt = now; await expect(f.open()).rejects.toThrow();
    expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("renders at most five frames per second and closes at the total deadline", async () => {
    const f = setup(), receipt = await f.open();
    expect(receipt).toMatchObject({ schema: "ananta.meet-avatar-source.v1", profile: "neutral-ai-v1", width: 256, height: 256, fps: 5, expiresAt: now + 30_000 });
    vi.advanceTimersByTime(999); expect(f.surface.frame).toHaveBeenCalledTimes(5);
    f.source.pulse(receipt.generation);
    for (let i = 0; i < 14; i++) { vi.advanceTimersByTime(2000); f.source.pulse(receipt.generation); }
    vi.advanceTimersByTime(1001); expect(f.surface.frame).toHaveBeenCalledTimes(150);
    expect(f.source.status().state).toBe("failed"); expect(f.surface.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000); expect(f.surface.frame).toHaveBeenCalledTimes(150);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits only ten seconds for protection and never renders before readiness", async () => {
    const f = setup(); f.surface.ready.mockReturnValue(false);
    const pending = expect(f.open()).rejects.toThrow("meet_avatar_setup_timeout");
    const generation = f.source.status().generation;
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(2000); f.source.pulse(generation); }
    vi.advanceTimersByTime(2000); await pending;
    expect(f.surface.frame).not.toHaveBeenCalled(); expect(f.surface.close).toHaveBeenCalledOnce();
    f.surface.ready.mockReturnValue(true); vi.advanceTimersByTime(100);
    expect(f.source.status().state).toBe("failed");
  });
  it("includes setup time in the lease deadline and reports readiness only after a real frame", async () => {
    const f = setup(); f.surface.ready.mockReturnValue(false); f.authority.expiresAt = now + 2000;
    const pending = f.open(); vi.advanceTimersByTime(500); f.surface.ready.mockReturnValue(true);
    vi.advanceTimersByTime(100); expect((await pending).expiresAt).toBe(now + 2000);
    expect(f.surface.frame).toHaveBeenCalledExactlyOnceWith(1);
    vi.advanceTimersByTime(1400); expect(f.source.status().state).toBe("failed");
  });
  it("fences every authority dimension, revocation and backwards clock", async () => {
    const changes = [
      (f: ReturnType<typeof setup>) => { f.authority.sourceId = "avatar:other"; },
      (f: ReturnType<typeof setup>) => { f.authority.sessionId = "ms_other"; },
      (f: ReturnType<typeof setup>) => { f.authority.leaseGeneration++; },
      (f: ReturnType<typeof setup>) => { f.authority.membershipEpoch++; },
      (f: ReturnType<typeof setup>) => { f.authority.expiresAt++; },
      (f: ReturnType<typeof setup>) => { f.ports.authority.mockImplementation(() => { throw new Error("denied"); }); },
      () => { vi.setSystemTime(now - 1000); },
    ];
    for (const change of changes) {
      vi.setSystemTime(now); const f = setup(); await f.open(); change(f); vi.advanceTimersByTime(100);
      expect(f.source.status().state).toBe("failed"); expect(f.surface.close).toHaveBeenCalledOnce();
      expect(f.surface.frame).toHaveBeenCalledOnce();
    }
  });
  it("rejects cancellation during setup and stale close cannot stop a new generation", async () => {
    const f = setup(); f.surface.ready.mockReturnValue(false);
    const old = expect(f.open()).rejects.toThrow("meet_avatar_closed");
    const generation = f.source.status().generation; f.source.close(generation); await old;
    f.surface.ready.mockReturnValue(true); const fresh = await f.open();
    for (const value of [generation, NaN, 1.5]) expect(f.source.close(value)).toBe(false);
    expect(f.source.status().state).toBe("open");
    await expect(f.open()).rejects.toThrow("meet_avatar_busy");
    expect(f.source.close(fresh.generation)).toBe(true); f.source.close();
    expect(f.surface.close).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds creation, rendering and protection-loss failures without leaked timers", async () => {
    const create = setup(); create.ports.create.mockImplementation(() => { throw new Error("unsupported"); });
    await expect(create.open()).rejects.toThrow("unsupported"); expect(create.source.status().state).toBe("failed");
    const frame = setup(); frame.surface.frame.mockImplementation(() => { throw new Error("ended"); });
    frame.surface.close.mockImplementation(() => { throw new Error("already detached"); });
    await expect(frame.open()).rejects.toThrow("ended"); expect(vi.getTimerCount()).toBe(0);
    const protectedSource = setup(); await protectedSource.open(); protectedSource.surface.ready.mockReturnValue(false);
    vi.advanceTimersByTime(2100); expect(protectedSource.source.status().state).toBe("failed");
  });
  it("quiesces during bounded rekey and resumes only under identical fresh authority", async () => {
    const f = setup(); const receipt = await f.open(); f.surface.ready.mockReturnValue(false);
    vi.advanceTimersByTime(500); expect(f.source.status().state).toBe("waiting");
    expect(f.surface.frame).toHaveBeenCalledOnce(); f.surface.ready.mockReturnValue(true);
    vi.advanceTimersByTime(100); expect(f.source.status().state).toBe("open");
    expect(f.source.status().expiresAt).toBe(receipt.expiresAt); expect(f.surface.frame).toHaveBeenCalledTimes(2);
    f.surface.ready.mockReturnValue(false); f.authority.leaseGeneration++;
    vi.advanceTimersByTime(100); expect(f.source.status().state).toBe("failed"); f.source.close();
  });
  it("closed polling does not consume generations or authority", async () => {
    const f = setup(); for (let i = 0; i < 4000; i++) { f.source.close(); f.source.status(); }
    expect(f.ports.authority).not.toHaveBeenCalled(); expect((await f.open()).generation).toBe(1); f.source.close();
  });
  it.each(["clock-backwards", "membership-epoch", "lease-generation", "lease-expiry", "controller-expired"])(
    "retains a fixed internal %s reason without leaking authority values", async reason => {
      const f = setup(); const receipt = await f.open();
      if (reason === "clock-backwards") vi.setSystemTime(now - 1);
      if (reason === "membership-epoch") f.authority.membershipEpoch++;
      if (reason === "lease-generation") f.authority.leaseGeneration++;
      if (reason === "lease-expiry") f.authority.expiresAt++;
      if (reason === "controller-expired") vi.setSystemTime(now + 2500);
      let error: unknown; try { f.source.pulse(receipt.generation); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ message: "meet_avatar_authority_expired", cause: reason });
      expect(f.source.status().state).toBe("failed"); expect(f.surface.close).toHaveBeenCalledOnce();
    });
  it("stops on a missing controller pulse and a late pulse cannot revive it", async () => {
    const f = setup(), lease = await f.open();
    expect(lease.heartbeatMs).toBe(2500); vi.advanceTimersByTime(2500);
    expect(f.source.status().state).toBe("failed"); expect(f.surface.close).toHaveBeenCalledOnce();
    expect(() => f.source.pulse(lease.generation)).toThrow(); expect(f.surface.frame).toHaveBeenCalledTimes(13);
    const fresh = await f.open(); expect(() => f.source.pulse(lease.generation)).toThrow("meet_avatar_pulse_stale");
    vi.advanceTimersByTime(2000); f.source.pulse(fresh.generation); vi.advanceTimersByTime(1000);
    expect(f.source.status().state).toBe("open"); f.source.close();
  });
  it("never uses a pulse to extend expired authority or continue a pending setup after controller loss", async () => {
    const f = setup(); f.surface.ready.mockReturnValue(false);
    const pending = expect(f.open()).rejects.toThrow("meet_avatar_authority_expired");
    vi.advanceTimersByTime(2500); await pending; expect(f.surface.frame).not.toHaveBeenCalled();
    f.surface.ready.mockReturnValue(true); const fresh = await f.open(); f.authority.leaseGeneration++;
    expect(() => f.source.pulse(fresh.generation)).toThrow(); expect(f.source.status().state).toBe("failed");
  });
});
