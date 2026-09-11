import { describe, expect, it, vi, afterEach } from "vitest";
import { parsePlaybackCapacity, type PlaybackCapacity } from "./playback-capacity";
import { PlaybackCapacityController, type PlaybackCapacityState } from "./playback-capacity-controller";
import { requestPlaybackCapacity } from "./playback-capacity-http";
const program = { programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 4, programEpoch: 2 };
const value = (): PlaybackCapacity => ({ version: 1, ...program, observedAt: 1800000000000, expiresAt: 1800000005000,
  reserved: false, programSessions: 3, programLimit: 500, perAudienceLimit: 4, additionalSessions: 20, sharedBudgetsFit: true });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("strictly correlates scope, demand, time and bounds, without accepting unknown fields", () => {
  const good = value(); expect(parsePlaybackCapacity(good, program, 20)).toEqual(good);
  for (const field of Object.keys(good)) {
    const bad = { ...good } as Record<string, unknown>; delete bad[field];
    expect(() => parsePlaybackCapacity(bad, program, 20)).toThrow();
    bad[field] = null; expect(() => parsePlaybackCapacity(bad, program, 20)).toThrow();
  }
  for (const patch of [{ tenantId: "private" }, { version: 2 }, { reserved: true }, { programEpoch: 3 }, { programRevision: 5 },
    { programId: "prg_bbbbbbbbbbbbbbbb" }, { programSessions: -1 }, { programLimit: 10001 }, { perAudienceLimit: 0.5 },
    { additionalSessions: 19 }, { sharedBudgetsFit: 1 }, { programLimit: 4 }, { observedAt: NaN },
    { expiresAt: good.observedAt }, { expiresAt: good.expiresAt + 1 }]) expect(() => parsePlaybackCapacity({ ...good, ...patch }, program, 20)).toThrow();
  expect(parsePlaybackCapacity({ ...good, sharedBudgetsFit: false, programLimit: 0, perAudienceLimit: 0 }, program, 20).sharedBudgetsFit).toBe(false);
});
function fixture() {
  let now = 10, context: any = { key: "session", program: { ...program }, additionalSessions: 20 };
  let resolve!: (v: PlaybackCapacity) => void;
  const query = vi.fn((_p, _n, _signal) => new Promise<PlaybackCapacity>(r => { resolve = r; }));
  const states: PlaybackCapacityState[] = [];
  const controller = new PlaybackCapacityController({ context: () => context, now: () => now, query, changed: s => states.push(s) });
  return { controller, query, states, setNow: (v: number) => { now = v; }, context: () => context,
    leave: () => { context = null; }, resolver: () => resolve, resolve: (v = value()) => resolve(v) };
}
it("never queries automatically and expires from request start, including shortened server lifetime", async () => {
  const f = fixture(); f.controller.tick(); expect(f.query).not.toHaveBeenCalled();
  const pending = f.controller.query(); f.setNow(4100); f.resolve(); await pending;
  expect(f.states.at(-1)?.phase).toBe("current");
  f.setNow(5010); f.controller.tick(); expect(f.states.at(-1)).toEqual({ phase: "stale", value: null });
  expect(f.query.mock.calls[0][2].aborted).toBe(true);
  const g = fixture(), second = g.controller.query(); g.setNow(111); g.resolve({ ...value(), expiresAt: value().observedAt + 100 });
  await second; expect(g.states.at(-1)?.phase).toBe("stale");
});
describe.each(["leave", "epoch", "revision", "demand", "clock-rollback", "clock-invalid", "timeout"])("%s fences pending/current output", mutation => {
  it.each([false, true])("removes output and rejects late reply (already received: %s)", async received => {
    const f = fixture(), pending = f.controller.query();
    if (received) { f.resolve(); await pending; }
    if (mutation === "leave") f.leave();
    if (mutation === "epoch") f.context().program.programEpoch++;
    if (mutation === "revision") f.context().program.programRevision++;
    if (mutation === "demand") f.context().additionalSessions++;
    if (mutation === "clock-rollback") f.setNow(9);
    if (mutation === "clock-invalid") f.setNow(NaN);
    if (mutation === "timeout") f.setNow(5010);
    f.controller.tick(); f.resolve(); await pending;
    expect(f.states.at(-1)).toEqual({ phase: "stale", value: null }); expect(f.query.mock.calls[0][2].aborted).toBe(true);
  });
});
it("rejects malformed results, cancels older requests and never revives after destroy", async () => {
  const f = fixture(), first = f.controller.query(), resolveFirst = f.resolver();
  const firstSignal = f.query.mock.calls[0][2], second = f.controller.query();
  expect(firstSignal.aborted).toBe(true);
  f.resolve({ ...value(), reserved: true } as never); await second;
  expect(f.states.at(-1)?.phase).toBe("unavailable");
  resolveFirst(value()); await first; expect(f.states.at(-1)?.phase).toBe("unavailable");
  const g = fixture(), pending = g.controller.query(); g.controller.destroy(); const n = g.states.length;
  g.resolve(); await pending; await g.controller.query(); expect(g.states.length).toBe(n); expect(g.query).toHaveBeenCalledTimes(1);
});
it("HTTP sends only device + revision/epoch/demand, bounds JSON and honors cancellation", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(value()), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const readJson = vi.fn(async (r: Response) => r.json());
  const ports = { fingerprint: () => "a".repeat(43), authorizationHeader: () => ({ authorization: "Bearer fixture" }), readJson,
    responseError: () => new Error("denied") };
  const abort = new AbortController();
  expect(await requestPlaybackCapacity(program, 20, abort.signal, ports)).toEqual(value());
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`/api/broadcasts/${program.programId}/playback-capacity`); expect(url).not.toContain("fixture");
  expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error" });
  expect(JSON.parse(options.body as string)).toEqual({ requestVersion: 1, deviceFingerprint: "a".repeat(43),
    expectedProgramRevision: 4, expectedProgramEpoch: 2, additionalSessions: 20 });
  expect(readJson).toHaveBeenCalledWith(expect.any(Response), "invalid_playback_capacity_response", 2048);
  abort.abort(); await expect(requestPlaybackCapacity(program, 20, abort.signal, ports)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
