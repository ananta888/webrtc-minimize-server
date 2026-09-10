import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSceneState, parseNativeSceneResult, SCENE_LAYOUTS } from "./native-source-scene-contract";
import { NativeSceneContext, NativeSceneView, NativeSourceSceneController } from "./native-source-scene-controller";
import { NativeSourceSceneComponent } from "./native-source-scene.component";

const now = 1800000000000;
const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 4, programEpoch: 2 };
const source = "sls_aaaaaaaaaaaaaaaa";
const state: NativeSceneState = { sceneControlVersion: 1, ...{ programId: program.programId, programRevision: 4, programEpoch: 2 },
  packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 3,
  outcome: "observed", observedAt: now, sceneRevision: 1, layout: "single", sourceLeaseIds: [source], activeSourceLeaseId: source,
  availableSources: [{ sourceLeaseId: source, sourceKind: "screen" }] };
const selection = { expectedSceneRevision: 1, layout: "grid" as const, sourceLeaseIds: [source], activeSourceLeaseId: "" };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("v2 observations retain exact frozen fits without adding fields to v1", () => {
  const v2 = { ...state, sceneControlVersion: 2, sourceFits: ["cover"] };
  const parsed = parseNativeSceneResult(v2, program, now);
  expect(parsed).toHaveProperty("sourceFits", ["cover"]);
  if (parsed.outcome !== "observed") throw new Error();
  expect(Object.isFrozen(parsed.sourceFits)).toBe(true);
  for (const fits of [undefined, null, [], ["contain", "cover"], ["stretch"]]) {
    expect(() => parseNativeSceneResult({ ...v2, sourceFits: fits }, program, now)).toThrow();
  }
  expect(() => parseNativeSceneResult({ ...v2, sceneControlVersion: 1 }, program, now)).toThrow();
});

it("v2 apply requires explicit fits and rejects a downgraded native receipt", async () => {
  const f = fixture(); f.request.mockResolvedValue({ ...state, sceneControlVersion: 2, sourceFits: ["contain"] });
  await f.controller.refresh();
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValue({ sceneControlVersion: 1, outcome: "applied", sceneRevision: 2 });
  await f.controller.apply({ ...selection, sourceFits: ["cover"] }, "user-action");
  expect(f.views.at(-1)?.phase).toBe("unavailable"); f.controller.destroy();
});

it("v2 UI copies the observed fit and confirms the exact ordered presentation before applying", async () => {
  const scenes = { view: signal<NativeSceneView>({ phase: "ready", scene: { ...state, sceneControlVersion: 2, sourceFits: ["cover"] } }),
    controller: { refresh: vi.fn(async () => {}), apply: vi.fn(async () => {}) } };
  const component = new NativeSourceSceneComponent(scenes as never);
  await component.refresh(); expect(component.fits()[source]).toBe("cover");
  component.setFit(source, "stretch"); expect(component.fits()[source]).toBe("cover");
  component.setFit("sls_bbbbbbbbbbbbbbbb", "contain"); expect(Object.keys(component.fits())).toEqual([source]);
  const confirm = vi.spyOn(window, "confirm").mockImplementation(() => { component.setFit(source, "contain"); return true; });
  await component.apply(); expect(scenes.controller.apply).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await component.apply();
  expect(scenes.controller.apply).toHaveBeenCalledExactlyOnceWith({ expectedSceneRevision: 1, layout: "single",
    sourceLeaseIds: [source], activeSourceLeaseId: source, sourceFits: ["contain"] }, "user-action");
});

it("parses closed frozen scene observations and separates configured revoked slots from available sources", () => {
  const observed = parseNativeSceneResult({ ...state, availableSources: [] }, program, now);
  expect(observed.outcome).toBe("observed");
  expect(Object.isFrozen(observed)).toBe(true);
  if (observed.outcome !== "observed") throw new Error();
  expect(Object.isFrozen(observed.sourceLeaseIds)).toBe(true);
  expect(observed.sourceLeaseIds).toEqual([source]); expect(observed.availableSources).toEqual([]);
  for (const layout of SCENE_LAYOUTS) expect(parseNativeSceneResult({ ...state, layout, activeSourceLeaseId: "" }, program, now)).toHaveProperty("layout", layout);
});

it("rejects scope, freshness, unknown fields, oversized lists and unsupported layouts", () => {
  for (const patch of [{ extra: true }, { sceneControlVersion: 2 }, { programId: "prg_bbbbbbbbbbbbbbbb" }, { programRevision: 5 },
    { programEpoch: 3 }, { observedAt: now - 5000 }, { observedAt: now + 1001 }, { sceneRevision: 0 }, { layout: "unknown" },
    { sourceLeaseIds: [source, source] }, { activeSourceLeaseId: "sls_bbbbbbbbbbbbbbbb" },
    { availableSources: [state.availableSources[0], state.availableSources[0]] }, { availableSources: [{ ...state.availableSources[0], sourceKind: "microphone" }] }]) {
    expect(() => parseNativeSceneResult({ ...state, ...patch }, program, now)).toThrow("invalid_native_scene_response");
  }
  for (const field of Object.keys(state)) {
    const invalid = { ...state }; Reflect.deleteProperty(invalid, field);
    expect(() => parseNativeSceneResult(invalid, program, now)).toThrow();
  }
});

function fixture() {
  let clock = now, context: NativeSceneContext | null = { key: "session-alpha", program };
  const views: NativeSceneView[] = [];
  const request = vi.fn(async () => state as any);
  const controller = new NativeSourceSceneController({ context: () => context, clock: () => clock, request, changed: v => views.push(v) });
  return { controller, views, request, setClock: (v: number) => { clock = v; }, setContext: (v: NativeSceneContext | null) => { context = v; } };
}
it("never queries on construction and requires a fresh observation plus explicit click for apply", async () => {
  const f = fixture(); expect(f.request).not.toHaveBeenCalled();
  await f.controller.apply(selection, "user-action"); expect(f.request).not.toHaveBeenCalled();
  await f.controller.refresh(); expect(f.views.at(-1)?.phase).toBe("ready");
  await f.controller.apply(selection, "remote"); expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValue({ sceneControlVersion: 1, outcome: "applied", sceneRevision: 2 });
  await f.controller.apply(selection, "user-action");
  expect(f.views.at(-1)).toEqual({ phase: "stale", scene: null });
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(2);
  f.controller.destroy();
});
it("conflict requires a new query, never an automatic changed-revision retry", async () => {
  const f = fixture(); await f.controller.refresh(); f.request.mockResolvedValue({ sceneControlVersion: 1, outcome: "rejected" });
  await f.controller.apply(selection, "user-action"); expect(f.views.at(-1)?.phase).toBe("conflict");
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(2); f.controller.destroy();
});
it.each(["scope", "expired", "rollback"])("invalidates %s without a new request", async kind => {
  const f = fixture(); await f.controller.refresh();
  if (kind === "scope") f.setContext({ key: "session-beta", program });
  if (kind === "expired") f.setClock(now + 5000);
  if (kind === "rollback") f.setClock(now - 1);
  f.controller.tick(); expect(f.views.at(-1)).toEqual({ phase: "stale", scene: null });
  await f.controller.apply(selection, "user-action"); expect(f.request).toHaveBeenCalledTimes(1); f.controller.destroy();
});
it("bounds an unresponsive adapter and discards late results after room change or destruction", async () => {
  vi.useFakeTimers();
  for (const reason of ["timeout", "room", "destroy"]) {
    const f = fixture(); let resolve!: (v: any) => void;
    f.request.mockImplementation(() => new Promise(r => { resolve = r; }));
    const operation = f.controller.refresh();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(5000);
    if (reason === "room") { f.setContext(null); f.controller.tick(); }
    if (reason === "destroy") f.controller.destroy();
    await operation; const count = f.views.length;
    resolve(state); await Promise.resolve(); await Promise.resolve();
    expect(f.views).toHaveLength(count); expect(f.views.at(-1)?.phase).not.toBe("ready");
    expect(vi.getTimerCount()).toBe(0); f.controller.destroy();
  }
});
it("UI supports removing unavailable slots, exact confirmation, and no action while merely opened", async () => {
  const scenes = { view: signal<NativeSceneView>({ phase: "ready", scene: { ...state, availableSources: [] } }),
    controller: { refresh: vi.fn(async () => {}), apply: vi.fn(async () => {}) } };
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new NativeSourceSceneComponent(scenes as never));
  expect(scenes.controller.refresh).not.toHaveBeenCalled(); expect(scenes.controller.apply).not.toHaveBeenCalled();
  await component.refresh(); expect(component.selected()).toEqual([source]);
  component.remove(source); expect(component.selected()).toEqual([]); expect(component.active()).toBe("");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await component.apply(); expect(scenes.controller.apply).not.toHaveBeenCalled();
  confirm.mockImplementation(() => { component.setLayout("grid"); return true; });
  await component.apply(); expect(scenes.controller.apply).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await component.apply();
  expect(scenes.controller.apply).toHaveBeenCalledExactlyOnceWith({ expectedSceneRevision: 1, layout: "grid", sourceLeaseIds: [], activeSourceLeaseId: "" }, "user-action");
});
