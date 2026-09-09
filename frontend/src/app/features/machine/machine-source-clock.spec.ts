import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MachineSpeechSource } from "./machine-speech-source";
import { MachineAvatarSource } from "./machine-avatar-source";

const epoch = 1_788_000_000_000;
let wall: number, monotonic: number;
beforeEach(() => {
  vi.useFakeTimers(); wall = epoch; monotonic = 0;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
});
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(kind: "speech" | "avatar") {
  const authority = { sourceId: `${kind}:hub`, sessionId: "ms_fixture", leaseGeneration: 1,
    membershipEpoch: 1, expiresAt: epoch + 60_000 };
  const close = vi.fn();
  if (kind === "avatar") {
    const frame = vi.fn();
    const source = new MachineAvatarSource({ authority: () => authority, create: () => ({ ready: () => true, frame, close }) });
    const receipt = await source.open(authority.sourceId, "neutral-ai-v1");
    return { source, authority, close, receipt, heartbeat: () => source.pulse(receipt.generation) };
  }
  let progress!: (samples: number) => void, played = 0;
  const source = new MachineSpeechSource({ authority: () => authority,
    create: async (_total, notify) => { progress = notify; return { push() {}, close }; } });
  const receipt = await source.open(authority.sourceId, 882_000);
  return { source, authority, close, receipt, heartbeat() {
    source.push(receipt.generation, played, btoa("\u0001\u0000".repeat(441)));
    played += 441; progress(played);
  } };
}

for (const kind of ["speech", "avatar"] as const) {
  const interval = kind === "speech" ? 2000 : 2500;
  it(`${kind}: wall-clock correction inside the lease does not invent a local stall`, async () => {
    const f = await fixture(kind);
    monotonic = 499; wall += 2578;
    expect(f.source.status().state).toBe("open");
    expect(() => f.heartbeat()).not.toThrow();
    expect(f.source.status().state).toBe("open");
    expect(f.close).not.toHaveBeenCalled(); f.source.close();
  });
  it(`${kind}: exact local deadline stops even when epoch time stands still`, async () => {
    const f = await fixture(kind);
    monotonic = interval - 1; expect(f.source.status().state).toBe("open");
    monotonic = interval; expect(f.source.status().state).toBe("failed");
    expect(f.close).toHaveBeenCalledOnce();
    expect(() => f.heartbeat()).toThrow();
  });
  it(`${kind}: fresh progress cannot extend the absolute receipt expiry`, async () => {
    const f = await fixture(kind); f.heartbeat();
    monotonic = 1; wall = f.receipt.expiresAt;
    expect(f.source.status().state).toBe("failed"); expect(f.close).toHaveBeenCalledOnce();
  });
  it(`${kind}: heartbeats cannot extend the local activation cap with a frozen wall clock`, async () => {
    const f = await fixture(kind), limit = kind === "speech" ? 50_000 : 30_000;
    const expiresAt = f.receipt.expiresAt;
    for (monotonic = 1000; monotonic < limit; monotonic += 1000) {
      f.heartbeat(); expect(f.source.status().state).toBe("open");
    }
    expect(f.receipt.expiresAt).toBe(expiresAt);
    expect(f.source.status().state).toBe("failed"); expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(["wall", "monotonic"] as const)(`${kind}: backwards %s clock fails closed`, async clock => {
    const f = await fixture(kind);
    monotonic = 100; wall += 100; f.heartbeat();
    if (clock === "wall") --wall; else --monotonic;
    expect(f.source.status().state).toBe("failed"); expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([NaN, Infinity, -Infinity])(`${kind}: invalid monotonic clock %s fails closed`, async value => {
    const f = await fixture(kind); monotonic = value;
    expect(f.source.status().state).toBe("failed"); expect(f.close).toHaveBeenCalledOnce();
  });
}
