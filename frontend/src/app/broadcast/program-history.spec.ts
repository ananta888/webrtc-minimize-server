import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProgramHistory, type ProgramHistory } from "./program-history";
import { ProgramHistoryController, type ProgramHistoryView } from "./program-history-controller";
import { requestProgramHistory } from "./program-history-http";
const program = { programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 4, programEpoch: 2 };
const value = (): ProgramHistory => ({ version: 2, ...program, observedAt: 1800000000000, expiresAt: 1800000005000,
  complete: false, retentionMs: 900000, events: [{ kind: "state-changed", state: "live", programRevision: 4,
    programEpoch: 2, occurredAt: 1799999999000, standbyCount: 0, sourceKind: null, reason: null, controlRevision: null }] });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("strictly bounds and clones history, allowing newer read-only snapshots after stop or handoff", () => {
  const good = value(), result = parseProgramHistory(good, program);
  expect(result).toEqual(good); expect(Object.isFrozen(result.events[0])).toBe(true);
  good.events[0].state = "failed"; expect(result.events[0].state).toBe("live");
  for (const field of Object.keys(good)) {
    const bad = { ...good } as Record<string, unknown>; delete bad[field];
    expect(() => parseProgramHistory(bad, program)).toThrow();
    bad[field] = null; expect(() => parseProgramHistory(bad, program)).toThrow();
  }
  for (const patch of [{ token: "secret" }, { complete: true }, { version: 1 }, { retentionMs: 900001 },
    { programId: "prg_bbbbbbbbbbbbbbbb" }, { programRevision: 3 }, { programEpoch: 1 }, { observedAt: NaN },
    { expiresAt: good.observedAt }, { expiresAt: good.expiresAt + 1 }, { events: Array(33).fill(good.events[0]) }]) {
    expect(() => parseProgramHistory({ ...good, ...patch }, program)).toThrow();
  }
  for (const patch of [{ name: "private" }, { kind: "unknown" }, { state: "unknown" }, { standbyCount: 0.5 },
    { standbyCount: 3 }, { programEpoch: 3 }, { programRevision: 5 }, { occurredAt: good.observedAt + 1 },
    { occurredAt: good.observedAt - good.retentionMs }]) {
    expect(() => parseProgramHistory({ ...good, events: [{ ...good.events[0], ...patch }] }, program)).toThrow();
  }
  expect(() => parseProgramHistory({ ...good, events: [good.events[0], { ...good.events[0], occurredAt: good.observedAt }] }, program)).toThrow();
  expect(parseProgramHistory({ ...good, programEpoch: 3, programRevision: 10 }, program).programEpoch).toBe(3);
});
function fixture() {
  let now = 10, context: any = { key: "session", program: { ...program } }, resolve!: (v: ProgramHistory) => void;
  const query = vi.fn((_p, _signal) => new Promise<ProgramHistory>(r => { resolve = r; }));
  const states: ProgramHistoryView[] = [];
  const controller = new ProgramHistoryController({ context: () => context, query, now: () => now, changed: v => states.push(v) });
  return { controller, query, states, context: () => context, leave: () => { context = null; }, setNow: (n: number) => { now = n; },
    resolve: (v = value()) => resolve(v), resolver: () => resolve };
}
it("v2 action details cannot mix consent reasons, control revisions or unknown source kinds", () => {
  const base = value(), row = base.events[0];
  for (const patch of [
    { kind: "source-consented", sourceKind: "screen-audio", reason: null, controlRevision: null },
    { kind: "source-revoked", sourceKind: "camera", reason: "program-owner-removed", controlRevision: null },
    { kind: "scene-applied", sourceKind: null, reason: null, controlRevision: 2 },
    { kind: "audio-applied", sourceKind: null, reason: null, controlRevision: 3 },
  ]) {
    const good = { ...base, events: [{ ...row, ...patch }] };
    expect(parseProgramHistory(good, program).events[0]).toEqual(good.events[0]);
    for (const bad of [{ sourceKind: "private-source" }, { reason: "unknown" }, { controlRevision: 0 }, { controlRevision: 1.5 }]) {
      expect(() => parseProgramHistory({ ...base, events: [{ ...row, ...patch, ...bad }] }, program)).toThrow();
    }
  }
  expect(() => parseProgramHistory({ ...base, events: [{ ...row, reason: "expired" }] }, program)).toThrow();
});
it("has no automatic query and counts freshness from request start, not response receipt", async () => {
  const f = fixture(); f.controller.tick(); expect(f.query).not.toHaveBeenCalled();
  const pending = f.controller.query(); f.setNow(4100); f.resolve(); await pending;
  expect(f.states.at(-1)?.phase).toBe("ready"); f.setNow(5010); f.controller.tick();
  expect(f.states.at(-1)).toEqual({ phase: "stale", value: null }); expect(f.query.mock.calls[0][1].aborted).toBe(true);
  const g = fixture(), second = g.controller.query(); g.setNow(111); g.resolve({ ...value(), expiresAt: value().observedAt + 100 });
  await second; expect(g.states.at(-1)?.phase).toBe("stale");
});
describe.each(["leave", "session", "epoch", "revision", "rollback", "invalid", "timeout"])("%s", mutation => {
  it.each([false, true])("fences pending and displayed history (received %s)", async received => {
    const f = fixture(), pending = f.controller.query(); if (received) { f.resolve(); await pending; }
    if (mutation === "leave") f.leave();
    if (mutation === "session") f.context().key = "other";
    if (mutation === "epoch") f.context().program.programEpoch++;
    if (mutation === "revision") f.context().program.programRevision++;
    if (mutation === "rollback") f.setNow(9);
    if (mutation === "invalid") f.setNow(NaN);
    if (mutation === "timeout") f.setNow(5010);
    f.controller.tick(); f.resolve(); await pending;
    expect(f.states.at(-1)).toEqual({ phase: "stale", value: null }); expect(f.query.mock.calls[0][1].aborted).toBe(true);
  });
});
it("discards malformed, superseded and post-destroy replies", async () => {
  const f = fixture(), first = f.controller.query(), older = f.resolver(), second = f.controller.query();
  expect(f.query.mock.calls[0][1].aborted).toBe(true);
  f.resolve({ ...value(), complete: true } as never); await second;
  expect(f.states.at(-1)?.phase).toBe("unavailable"); older(value()); await first;
  expect(f.states.at(-1)?.phase).toBe("unavailable");
  const third = f.controller.query(); f.controller.destroy(); const count = f.states.length;
  f.resolve(); await third; await f.controller.query(); expect(f.states.length).toBe(count); expect(f.query).toHaveBeenCalledTimes(3);
});
it("HTTP is bounded, read-only, authenticated without URL tokens and abortable before/after JSON", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(value()))); vi.stubGlobal("fetch", fetcher);
  const readJson = vi.fn(async (r: Response) => r.json());
  const ports = { fingerprint: () => "a".repeat(43), authorizationHeader: () => ({ authorization: "Bearer synthetic" }),
    readJson, responseError: () => new Error("denied") };
  const abort = new AbortController(); expect(await requestProgramHistory(program, abort.signal, ports)).toEqual(value());
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`/api/broadcasts/${program.programId}/native-program-history`);
  expect(options).toMatchObject({ method: "POST", cache: "no-store", redirect: "error", credentials: "same-origin" });
  expect(JSON.parse(options.body as string)).toEqual({ requestVersion: 2, deviceFingerprint: "a".repeat(43) });
  expect(readJson).toHaveBeenCalledWith(expect.any(Response), "invalid_program_history_response", 16384);
  abort.abort(); await expect(requestProgramHistory(program, abort.signal, ports)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  const late = new AbortController(); readJson.mockImplementationOnce(async () => { late.abort(); return value(); });
  await expect(requestProgramHistory(program, late.signal, ports)).rejects.toThrow();
  fetcher.mockImplementationOnce(async () => new Response("", { status: 403 }));
  await expect(requestProgramHistory(program, new AbortController().signal, ports)).rejects.toThrow("denied");
});
