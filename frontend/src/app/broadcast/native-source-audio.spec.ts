import "@angular/compiler";
import { signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { NativeAudioState, parseNativeAudioResult, validAudioSelection } from "./native-source-audio-contract";
import { NativeAudioContext, NativeAudioView, NativeSourceAudioController } from "./native-source-audio-controller";
import { NativeSourceAudioComponent } from "./native-source-audio.component";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";

const now = 1800000000000, source = "sls_aaaaaaaaaaaaaaaa";
const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 4, programEpoch: 2 };
const state: NativeAudioState = { audioControlVersion: 1, programId: program.programId, programRevision: 4, programEpoch: 2,
  packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 3, outcome: "observed", observedAt: now, audioRevision: 2,
  sources: [{ sourceLeaseId: source, sourceKind: "microphone", leftGainQ15: 32768, rightGainQ15: 32768, muted: false }] };
const selection = { expectedAudioRevision: 2, sources: [{ sourceLeaseId: source, leftGainQ15: 16384, rightGainQ15: 8192, muted: true }] };
const v2Fixture = JSON.parse(readFileSync("native-broadcast-packager/testdata/source-audio-state.v2.json", "utf8"));
const strategyState: NativeAudioState = { ...state, audioControlVersion: 2, mix: v2Fixture.mix, encoding: v2Fixture.encoding };
const v3Fixture = JSON.parse(readFileSync("native-broadcast-packager/testdata/source-audio-state.v3.json", "utf8"));
const outputState: NativeAudioState = { ...state, audioControlVersion: 3, mix: v3Fixture.mix, encoding: v3Fixture.encoding };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("v3 reports real mono/stereo metadata but does not weaken v2 or permit output mutation via mixing", () => {
  const observed = parseNativeAudioResult(outputState, program, now, 3);
  if (observed.outcome !== "observed" || observed.audioControlVersion !== 3) throw new Error();
  expect(observed.encoding.channels).toBe(1); expect(Object.isFrozen(observed.encoding.renditions[0])).toBe(true);
  expect(() => parseNativeAudioResult(outputState, program, now, 2)).toThrow();
  expect(() => parseNativeAudioResult({ ...outputState, audioControlVersion: 2 }, program, now, 2)).toThrow();
  for (const channels of [0, 3, true]) expect(() => parseNativeAudioResult({ ...outputState,
    encoding: { ...outputState.encoding, channels } }, program, now, 3)).toThrow();
  const high = { ...outputState.encoding, channels: 1, renditions: [{ id: "low", targetBitsPerSecond: 192001 }] };
  expect(() => parseNativeAudioResult({ ...outputState, encoding: high }, program, now, 3)).toThrow();
  expect(() => parseNativeAudioResult({ ...outputState, encoding: { ...high, channels: 2 } }, program, now, 3)).not.toThrow();
  expect(validAudioSelection({ expectedAudioRevision: 2, sources: [], strategy: "balanced" }, 3)).toBe(true);
  expect(validAudioSelection({ ...selection, strategy: "balanced", encoding: high } as never, 3)).toBe(false);
});

it("v3 query/apply keeps capability fences and UI mixing for mono output", async () => {
  const f = fixture(); f.setContext({ key: "session-alpha", program, audioControlVersion: 3 });
  f.request.mockResolvedValue(outputState); await f.controller.refresh(); expect(f.views.at(-1)?.phase).toBe("ready");
  f.setContext({ key: "session-alpha", program, audioControlVersion: 2 });
  await f.controller.apply({ ...selection, strategy: "balanced" }, "user-action");
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.views.at(-1)?.phase).toBe("stale"); f.controller.destroy();
  const audio = { view: signal<NativeAudioView>({ phase: "ready", audio: outputState }),
    controller: { refresh: vi.fn(async () => {}), apply: vi.fn(async () => {}) } };
  const c = new NativeSourceAudioComponent(audio as never); await c.refresh(); c.setStrategy("balanced");
  vi.spyOn(window, "confirm").mockReturnValue(true); await c.apply();
  expect(audio.controller.apply).toHaveBeenCalledWith(expect.objectContaining({ strategy: "balanced" }), "user-action");
});

it("v3 HTTP negotiates the closed contract and rejects older replies", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-audio-director-request.v3.schema.json", "utf8")));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(outputState), { headers: { "content-type": "application/json" } }));
  const control = new BroadcastControlPlaneService({ authorizationHeader: () => ({}) } as never, { fingerprint: () => "a".repeat(43) } as never);
  const result = await control.nativeSourceAudio(program, null, new AbortController().signal, 3);
  expect(result.audioControlVersion).toBe(3); expect(validate(JSON.parse(String(fetch.mock.calls[0][1]!.body)))).toBe(true);
  fetch.mockImplementationOnce(async () => new Response(JSON.stringify(strategyState), { headers: { "content-type": "application/json" } }));
  await expect(control.nativeSourceAudio(program, null, new AbortController().signal, 3)).rejects.toThrow();
});
function fixture() {
  let clock = now, context: NativeAudioContext | null = { key: "session-alpha", program };
  const views: NativeAudioView[] = [], request = vi.fn(async () => state as any);
  const controller = new NativeSourceAudioController({ context: () => context, clock: () => clock, request, changed: v => views.push(v) });
  return { controller, views, request, setClock: (at: number) => { clock = at; }, setContext: (value: NativeAudioContext | null) => { context = value; } };
}
it("parses frozen audio snapshots and rejects injected or invalid metadata", () => {
  const result = parseNativeAudioResult(state, program, now); expect(Object.isFrozen(result)).toBe(true);
  if (result.outcome !== "observed") throw new Error(); expect(Object.isFrozen(result.sources[0])).toBe(true);
  for (const patch of [{ extra: true }, { programEpoch: 3 }, { programRevision: 5 }, { audioRevision: 0 },
    { observedAt: now - 5000 }, { observedAt: now + 1001 }, { sources: [state.sources[0], state.sources[0]] },
    { sources: [{ ...state.sources[0], leftGainQ15: 32769 }] }, { sources: [{ ...state.sources[0], sourceKind: "camera" }] },
    { sources: [{ ...state.sources[0], muted: null }] }]) expect(() => parseNativeAudioResult({ ...state, ...patch }, program, now)).toThrow();
  for (const key of Object.keys(state)) { const bad = { ...state }; Reflect.deleteProperty(bad, key); expect(() => parseNativeAudioResult(bad, program, now)).toThrow(); }
});
it("never queries on construction and requires fresh observation and explicit apply", async () => {
  const f = fixture(); expect(f.request).not.toHaveBeenCalled(); await f.controller.apply(selection, "user-action"); expect(f.request).not.toHaveBeenCalled();
  await f.controller.refresh(); expect(f.views.at(-1)?.phase).toBe("ready");
  await f.controller.apply(selection, "remote"); expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValue({ audioControlVersion: 1, outcome: "applied", audioRevision: 3 }); await f.controller.apply(selection, "user-action");
  expect(f.views.at(-1)).toEqual({ phase: "stale", audio: null });
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(2); f.controller.destroy();
});
it.each(["scope", "expired", "rollback"])("invalidates %s without replay", async kind => {
  const f = fixture(); await f.controller.refresh();
  if (kind === "scope") f.setContext(null); if (kind === "expired") f.setClock(now + 5000); if (kind === "rollback") f.setClock(now - 1);
  f.controller.tick(); expect(f.views.at(-1)).toEqual({ phase: "stale", audio: null });
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(1); f.controller.destroy();
});
it("bounds hung adapters and ignores late responses after room change or destroy", async () => {
  vi.useFakeTimers();
  for (const kind of ["timeout", "room", "destroy"]) {
    const f = fixture(); let resolve!: (value: any) => void;
    f.request.mockImplementation(() => new Promise(r => { resolve = r; })); const pending = f.controller.refresh();
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(5000);
    if (kind === "room") { f.setContext(null); f.controller.tick(); } if (kind === "destroy") f.controller.destroy();
    await pending; const count = f.views.length; resolve(state); await Promise.resolve(); await Promise.resolve();
    expect(f.views).toHaveLength(count); expect(f.views.at(-1)?.phase).not.toBe("ready"); expect(vi.getTimerCount()).toBe(0); f.controller.destroy();
  }
});
it("rejects observations which became stale before continuation, and forces requery on conflicts", async () => {
  const f = fixture(); f.request.mockImplementation(async () => { f.setClock(now + 5000); return state; });
  await f.controller.refresh(); expect(f.views.at(-1)?.phase).toBe("unavailable"); f.controller.destroy();
  const g = fixture(); await g.controller.refresh(); g.request.mockResolvedValue({ audioControlVersion: 1, outcome: "rejected" });
  await g.controller.apply(selection, "user-action"); expect(g.views.at(-1)?.phase).toBe("conflict");
  await g.controller.apply(selection, "user-action"); expect(g.request).toHaveBeenCalledTimes(2); g.controller.destroy();
});
it("UI changes only staged gains/mute and requires exact confirmation", async () => {
  const audio = { view: signal<NativeAudioView>({ phase: "ready", audio: state }), controller: { refresh: vi.fn(async () => {}), apply: vi.fn(async () => {}) } };
  const component = new NativeSourceAudioComponent(audio as never);
  expect(audio.controller.refresh).not.toHaveBeenCalled(); await component.refresh();
  component.setGain(source, "leftGainQ15", "50"); component.setGain(source, "rightGainQ15", "25"); component.setMuted(source, true);
  expect(component.levels()).toEqual(selection.sources); expect(audio.controller.apply).not.toHaveBeenCalled();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); await component.apply(); expect(audio.controller.apply).not.toHaveBeenCalled();
  confirm.mockImplementation(() => { component.setMuted(source, false); return true; }); await component.apply(); expect(audio.controller.apply).not.toHaveBeenCalled();
  component.setMuted(source, true); confirm.mockReturnValue(true); await component.apply();
  expect(audio.controller.apply).toHaveBeenCalledExactlyOnceWith(selection, "user-action");
});
it("HTTP adapter emits the closed director schema and checks returned scope", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-audio-director-request.v1.schema.json", "utf8")));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(state), { headers: { "content-type": "application/json" } }));
  const control = new BroadcastControlPlaneService({ authorizationHeader: () => ({ Authorization: "Bearer synthetic" }) } as never, { fingerprint: () => "a".repeat(43) } as never);
  await control.nativeSourceAudio(program, null, new AbortController().signal);
  expect(validate(JSON.parse(String(fetch.mock.calls[0][1]!.body)))).toBe(true);
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store" });
  await expect(control.nativeSourceAudio(program, null, AbortSignal.abort())).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("abort during lazy adapter loading cannot access identity or send a request", async () => {
  const fingerprint = vi.fn(() => "a".repeat(43)), authorizationHeader = vi.fn(() => ({}));
  const fetch = vi.spyOn(globalThis, "fetch");
  const control = new BroadcastControlPlaneService({ authorizationHeader } as never, { fingerprint } as never);
  const abort = new AbortController(), pending = control.nativeSourceAudio(program, null, abort.signal);
  abort.abort(); await expect(pending).rejects.toThrow();
  expect(fingerprint).not.toHaveBeenCalled(); expect(authorizationHeader).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("v2 snapshots require negotiated version and closed immutable strategy/encoding metadata", () => {
  const observed = parseNativeAudioResult(strategyState, program, now, 2);
  if (observed.outcome !== "observed" || observed.audioControlVersion !== 2) throw new Error();
  expect(Object.isFrozen(observed.mix)).toBe(true); expect(Object.isFrozen(observed.encoding.renditions[0])).toBe(true);
  expect(() => parseNativeAudioResult(strategyState, program, now)).toThrow();
  expect(() => parseNativeAudioResult(state, program, now, 2)).toThrow();
  for (const patch of [{ mix: null }, { encoding: null }, { mix: { ...strategyState.mix, strategy: "capture" } },
    { mix: { ...strategyState.mix, limiterGainQ15: 32769 } }, { encoding: { ...strategyState.encoding, codec: "opus" } },
    { encoding: { ...strategyState.encoding, renditions: [] } }, { encoding: { ...strategyState.encoding, channels: 1 } },
    { encoding: { ...strategyState.encoding, dtx: true } }]) expect(() => parseNativeAudioResult({ ...strategyState, ...patch }, program, now, 2)).toThrow();
  expect(validAudioSelection({ expectedAudioRevision: 2, sources: [], strategy: "balanced" }, 2)).toBe(true);
  expect(validAudioSelection({ expectedAudioRevision: 2, sources: [], strategy: "balanced" }, 1)).toBe(false);
  expect(validAudioSelection(selection, 2)).toBe(false);
});

it("v2 controller binds query and apply to capability version and rejects downgrade", async () => {
  const f = fixture(); f.setContext({ key: "session-alpha", program, audioControlVersion: 2 });
  f.request.mockResolvedValue(strategyState); await f.controller.refresh();
  expect(f.request).toHaveBeenLastCalledWith(program, null, expect.any(AbortSignal), 2);
  expect(f.views.at(-1)?.phase).toBe("ready");
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValue({ audioControlVersion: 1, outcome: "applied", audioRevision: 3 });
  await f.controller.apply({ ...selection, strategy: "balanced" }, "user-action");
  expect(f.views.at(-1)?.phase).toBe("unavailable"); f.controller.destroy();
  const g = fixture(); g.setContext({ key: "session-alpha", program, audioControlVersion: 2 });
  g.request.mockImplementation(async () => { g.setContext({ key: "session-alpha", program, audioControlVersion: 1 }); return strategyState; });
  await g.controller.refresh(); expect(g.views.at(-1)?.phase).toBe("unavailable"); g.controller.destroy();
});

it("v2 UI stages strategy alone, rejects unknown presets and cancels changed confirmations", async () => {
  const audio = { view: signal<NativeAudioView>({ phase: "ready", audio: { ...strategyState, sources: [] } }),
    controller: { refresh: vi.fn(async () => {}), apply: vi.fn(async () => {}) } };
  const c = new NativeSourceAudioComponent(audio as never); await c.refresh();
  expect(c.strategy()).toBe("speech-first"); c.setStrategy("balanced"); c.setStrategy("unsafe"); expect(c.strategy()).toBe("balanced");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); await c.apply(); expect(audio.controller.apply).not.toHaveBeenCalled();
  confirm.mockImplementation(() => { c.setStrategy("screen-first"); return true; });
  await c.apply(); expect(audio.controller.apply).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await c.apply();
  expect(audio.controller.apply).toHaveBeenCalledExactlyOnceWith({ expectedAudioRevision: 2, sources: [], strategy: "screen-first" }, "user-action");
  audio.view.set({ phase: "stale", audio: null }); c.setStrategy("unprocessed"); await c.apply(); expect(audio.controller.apply).toHaveBeenCalledTimes(1);
});

it("v2 HTTP emits the strict director schema and refuses a downgraded reply", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-audio-director-request.v2.schema.json", "utf8")));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(strategyState), { headers: { "content-type": "application/json" } }));
  const control = new BroadcastControlPlaneService({ authorizationHeader: () => ({ Authorization: "Bearer synthetic" }) } as never, { fingerprint: () => "a".repeat(43) } as never);
  const result = await control.nativeSourceAudio(program, null, new AbortController().signal, 2);
  expect(result.audioControlVersion).toBe(2); expect(validate(JSON.parse(String(fetch.mock.calls[0][1]!.body)))).toBe(true);
  fetch.mockImplementationOnce(async () => new Response(JSON.stringify(state), { headers: { "content-type": "application/json" } }));
  await expect(control.nativeSourceAudio(program, null, new AbortController().signal, 2)).rejects.toThrow("invalid_native_audio_response");
});
