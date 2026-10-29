import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarSequenceController } from "./machine-avatar-sequence-controller";
import { MachinePageLifecycle } from "./machine-page-lifecycle";

const value = () => ({ schema: "ananta.meet-avatar-sequence.v1", totalSamples: 3675,
  clips: [{ startSample: 0, endSample: 3675, content: { mp4: btoa("0000ftyp00000000"), sha256: "a".repeat(64),
    frames: 2, repeatMode: "hold_last", originKind: "generated", classification: "test_only" } }] });
function fixture() {
  let now = 1000, local = 1000;
  const scope = { sourceId: "avatar:synthetic", sessionId: "synthetic-session", leaseGeneration: 1,
    membershipEpoch: 1, expiresAt: 100000 };
  const frames = { draw: vi.fn(), close: vi.fn() };
  const ports = { authority: () => scope, progress: () => ({ state: "open", generation: 3,
    receivedSamples: 0, playedSamples: 0, bufferedSamples: 0 }),
    preparation: { prepare: vi.fn(async () => frames) }, clock: () => now, monotonicClock: () => local };
  const controller = new AvatarSequenceController(ports);
  return { controller, scope, frames, ports, rollback: () => { now--; }, localOnly: (delta: number) => { local += delta; } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("pollable preparation and current-authority activation", () => {
  it("empty unscoped cleanup permits first page admission without accepting unknown handles", async () => {
    const f = fixture(), join = vi.fn(async () => {}), failed = vi.fn();
    const page = new MachinePageLifecycle({ load: async () => {}, join, joined: () => true,
      cleanup: [() => f.controller.close()], cleanupFailed: failed });
    expect(f.controller.close(1)).toBe(false);
    await page.join("room-" + "a".repeat(18), "synthetic-grant");
    expect(join).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
    page.leave(); page.leave(); expect(failed).not.toHaveBeenCalled();
  });
  it("returns promptly, admits only ready live bindings, and transfers atlas ownership", async () => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value());
    try {
      expect(f.controller.status(prepared.id).state).toBe("preparing");
      expect(() => f.controller.activate({ id: prepared.id, speechGeneration: 3 }, () => {})).toThrow("not_ready");
      await flush(); expect(f.controller.status(prepared.id).state).toBe("ready");
      const artwork = f.controller.activate({ id: prepared.id, speechGeneration: 3 }, () => {});
      artwork.draw({ fillText: vi.fn() } as never);
      expect(f.frames.draw).toHaveBeenCalledOnce();
      artwork.close(); expect(f.controller.status(prepared.id).state).toBe("closed");
    } finally { f.controller.close(); }
  });
  it.each(["leaseGeneration", "membershipEpoch", "expiresAt"])("never promotes old preparation across %s", async key => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value()); await flush();
    f.scope[key as "leaseGeneration"]++;
    expect(f.controller.status(prepared.id).state).toBe("failed");
    expect(() => f.controller.activate({ id: prepared.id, speechGeneration: 3 }, () => {})).toThrow();
    expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("bounds an unused ready atlas by monotonic time", async () => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value()); await flush();
    f.localOnly(20000);
    expect(f.controller.status(prepared.id).state).toBe("failed"); expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("retires on backwards clock without extending the lease", async () => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value()); await flush();
    f.rollback(); expect(f.controller.status(prepared.id).state).toBe("failed");
  });
  it("disposes a late atlas after cancellation rather than restoring ready state", async () => {
    const f = fixture(); let resolve!: (value: typeof f.frames) => void;
    f.ports.preparation.prepare.mockImplementation(() => new Promise(r => { resolve = r; }));
    const prepared = f.controller.prepare(f.scope.sourceId, value());
    f.controller.close(prepared.id); resolve(f.frames); await flush();
    expect(f.frames.close).toHaveBeenCalledOnce(); expect(f.controller.status(prepared.id).state).toBe("closed");
  });
  it("rejects wrong generation and retires its ready resources", async () => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value()); await flush();
    expect(() => f.controller.activate({ id: prepared.id, speechGeneration: 5 }, () => {})).toThrow("progress_invalid");
    expect(f.controller.status(prepared.id).state).toBe("failed"); expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("unknown binding fields and stale cleanup cannot claim the active generation", async () => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value()); await flush();
    try {
      expect(() => f.controller.activate({ id: prepared.id, speechGeneration: 3, authorization: true }, () => {}))
        .toThrow("binding_invalid");
      expect(f.controller.close(prepared.id + 1)).toBe(false);
      expect(f.controller.status(prepared.id).state).toBe("ready");
    } finally { f.controller.close(); }
  });
  it("reports only observed segment switches and requires rendered native completion", async () => {
    const f = fixture(), prepared = f.controller.prepare(f.scope.sourceId, value()); await flush();
    try {
      const artwork = f.controller.activate({ id: prepared.id, speechGeneration: 3 }, () => {});
      expect(f.controller.quality(prepared.id).sync_complete).toBe(false);
      artwork.draw({ fillText: vi.fn() } as never);
      f.ports.progress = () => ({ state: "completed", generation: 4,
        receivedSamples: 3675, playedSamples: 3675, bufferedSamples: 0 });
      expect(f.controller.quality(prepared.id).sync_complete).toBe(false);
      artwork.draw({ fillText: vi.fn() } as never);
      expect(f.controller.quality(prepared.id)).toMatchObject({ sync_complete: true, max_drift_us: 0,
        segments: [{ segment: 0, expected_start_sample: 0, observed_played_sample: 0, drift_us: 0 }] });
      artwork.close();
    } finally { f.controller.close(); }
  });
});
