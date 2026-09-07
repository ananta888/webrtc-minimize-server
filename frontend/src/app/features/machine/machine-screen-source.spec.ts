import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineScreenSource, screenJpeg } from "./machine-screen-source";

const now = 1_788_000_000_000;
// Header-only decoder fixture; actual JPEG decoding is covered by browser integration.
const header = [255, 216, 255, 192, 0, 17, 8, 1, 104, 2, 128, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 217];
const encode = (values = header) => btoa(String.fromCharCode(...values));
function setup() {
  const authority = { sourceId: "screen:hub", sessionId: "ms_test", leaseGeneration: 1, membershipEpoch: 2, expiresAt: now + 60_000 };
  const surface = { draw: vi.fn(), frame: vi.fn(), close: vi.fn() };
  const bitmap = { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap;
  const ports = { authority: () => authority, create: vi.fn(() => surface), decode: vi.fn(async () => bitmap), monotonic: () => Date.now() };
  return { source: new MachineScreenSource(ports), authority, surface, bitmap, ports };
}
describe("isolated machine screen source", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("validates baseline dimensions and byte bounds before decoding", () => {
    expect(screenJpeg(encode()).length).toBe(header.length);
    for (const value of ["", "!", "a".repeat(350001), encode(header.map((n, i) => i === 9 ? 255 : n)), encode([255, 216, 255, 217])]) {
      expect(() => screenJpeg(value)).toThrow();
    }
  });
  it("does not exhaust source generations while an unselected source stays closed", () => {
    const f = setup();
    for (let i = 0; i < 4000; i++) f.source.close();
    const lease = f.source.open("screen:hub");
    f.source.close();
    for (let i = 0; i < 4000; i++) f.source.close();
    expect(f.source.open("screen:hub").generation).toBeGreaterThan(lease.generation);
    f.source.close();
  });
  it("uses the verified source identity and publishes bounded frames independently", async () => {
    const f = setup(); expect(() => f.source.open("screen:other")).toThrow("meet_screen_source_denied");
    expect(f.ports.create).not.toHaveBeenCalled();
    const lease = f.source.open("screen:hub"); expect(lease).toMatchObject({ width: 640, height: 360, fps: 5, expiresAt: now + 30_000 });
    await f.source.push(lease.generation, 1, encode()); expect(f.surface.frame).toHaveBeenCalledOnce();
    await expect(f.source.push(lease.generation, 2, encode())).rejects.toThrow("meet_screen_frame_order_invalid");
    vi.advanceTimersByTime(200); await f.source.push(lease.generation, 2, encode());
    expect(f.surface.frame).toHaveBeenCalledTimes(2); expect(f.bitmap.close).toHaveBeenCalledTimes(2);
    f.source.close(); expect(f.surface.close).toHaveBeenCalledOnce();
  });
  it("stops on lease or membership change, stalled delivery and clock rollback", () => {
    for (const revoke of [(f: ReturnType<typeof setup>) => f.authority.leaseGeneration++,
      (f: ReturnType<typeof setup>) => f.authority.membershipEpoch++,
      () => vi.setSystemTime(now - 1000), () => vi.setSystemTime(now + 2001)]) {
      vi.setSystemTime(now); const f = setup(); f.source.open("screen:hub"); revoke(f); vi.advanceTimersByTime(100);
      expect(f.source.status().open).toBe(false); expect(f.surface.close).toHaveBeenCalledOnce();
    }
  });
  it("reports a bounded stop category without exposing source identity or key material", () => {
    const f = setup(); f.source.open("screen:hub"); vi.advanceTimersByTime(2100);
    expect(f.source.diagnostics().lastStopReason).toBe("frame_stalled");
    const status = JSON.stringify(f.source.diagnostics()); expect(status).not.toContain("screen:hub");
    expect(Object.keys(f.source.status()).sort()).toEqual(["generation", "open", "sequence"]);
    f.source.open("screen:hub"); expect(f.source.diagnostics().lastStopReason).toBe("");
    f.authority.membershipEpoch++; vi.advanceTimersByTime(100); expect(f.source.diagnostics().lastStopReason).toBe("scope_changed");
  });
  it("uses monotonic frame timing across forward wall-clock steps but keeps absolute expiry", async () => {
    const f = setup(); let elapsed = 0; f.ports.monotonic = () => elapsed;
    const source = new MachineScreenSource(f.ports), lease = source.open("screen:hub");
    await source.push(lease.generation, 1, encode());
    elapsed = 250; vi.setSystemTime(now + 5000);
    await source.push(lease.generation, 2, encode()); expect(source.status().open).toBe(true);
    elapsed = 500; vi.setSystemTime(now + 30_000);
    await expect(source.push(lease.generation, 3, encode())).rejects.toThrow("meet_screen_authority_changed");
    expect(source.diagnostics().lastStopReason).toBe("activation_expired");
  });
  it("fences pending decodes after close/reopen and enforces one frame in flight", async () => {
    const f = setup(); let resolve!: (value: ImageBitmap) => void;
    f.ports.decode.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const old = f.source.open("screen:hub"), pending = f.source.push(old.generation, 1, encode());
    await expect(f.source.push(old.generation, 1, encode())).rejects.toThrow();
    f.source.close(); const current = f.source.open("screen:hub");
    resolve(f.bitmap); await expect(pending).rejects.toThrow("meet_screen_frame_stale");
    expect(f.source.status().open).toBe(true); expect(f.surface.draw).not.toHaveBeenCalled();
    await f.source.push(current.generation, 1, encode()); expect(f.surface.draw).toHaveBeenCalledOnce(); f.source.close();
  });
  it("bounds decoding and closes late bitmaps without ever drawing them", async () => {
    const f = setup(); let resolve!: (value: ImageBitmap) => void;
    f.ports.decode.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const lease = f.source.open("screen:hub"); const pending = expect(f.source.push(lease.generation, 1, encode())).rejects.toThrow("meet_screen_decode_timeout");
    await vi.advanceTimersByTimeAsync(1000); await pending;
    resolve(f.bitmap); await Promise.resolve(); expect(f.bitmap.close).toHaveBeenCalledOnce();
    expect(f.surface.draw).not.toHaveBeenCalled(); expect(f.source.status().open).toBe(false);
  });
});
