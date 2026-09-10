import "@angular/compiler";
import { signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSceneSelection, NativeSceneState } from "./native-source-scene-contract";
import { NativeSceneView } from "./native-source-scene-controller";
import { NativeSourceSceneComponent } from "./native-source-scene.component";
import { sameSceneScope, sceneDraftRefresh } from "./native-source-scene-draft";

const source = "sls_aaaaaaaaaaaaaaaa", second = "sls_bbbbbbbbbbbbbbbb";
const state: NativeSceneState = { sceneControlVersion: 2, programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1,
  packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 1,
  outcome: "observed", observedAt: 1800000000000, sceneRevision: 1, layout: "single", sourceLeaseIds: [source],
  sourceFits: ["contain"], activeSourceLeaseId: "", availableSources: [{ sourceLeaseId: source, sourceKind: "camera" }] };
const draft: NativeSceneSelection = { expectedSceneRevision: 1, layout: "grid", sourceLeaseIds: [source], sourceFits: ["cover"], activeSourceLeaseId: "" };
afterEach(() => vi.restoreAllMocks());

it("retains dirty intent only across an unchanged scene, not a concurrent change or rollback", () => {
  expect(sceneDraftRefresh(state, { ...state, observedAt: state.observedAt + 1000 }, draft)).toBe("retain");
  for (const patch of [{ sceneRevision: 2 }, { sceneRevision: 0 }, { layout: "end-slate" as const }, { sourceFits: ["cover" as const] }]) {
    expect(sceneDraftRefresh(state, { ...state, ...patch }, draft)).toBe("conflict");
  }
  expect(sceneDraftRefresh(state, { ...state, sceneRevision: 2, layout: draft.layout, sourceFits: draft.sourceFits }, draft)).toBe("replace");
  expect(sceneDraftRefresh(null, state, null)).toBe("replace");
});

it("every program, writer, fencing and protocol boundary replaces the old draft", () => {
  for (const patch of [{ programId: "prg_bbbbbbbbbbbbbbbb" }, { programRevision: 2 }, { programEpoch: 2 },
    { packagerId: "pkr_bbbbbbbbbbbbbbbb" }, { assignmentId: "asn_bbbbbbbbbbbbbbbb" }, { fencingRevision: 2 },
    { sceneControlVersion: 1 as const, sourceFits: undefined }]) {
    const next = { ...state, ...patch };
    expect(sameSceneScope(state, next)).toBe(false); expect(sceneDraftRefresh(state, next, draft)).toBe("replace");
  }
});

async function fixture() {
  const owner = signal<string | null>("human-session-alpha");
  let next = state;
  const scenes = { ownerKey: () => owner(), view: signal<NativeSceneView>({ phase: "idle", scene: null }), controller: {
    refresh: vi.fn(async () => { scenes.view.set({ phase: "ready", scene: next }); }), apply: vi.fn(async () => {}),
  } };
  const component = new NativeSourceSceneComponent(scenes as never);
  await component.refresh();
  return { component, scenes, owner, next(value: NativeSceneState) { next = value; } };
}

it("edits survive expiry and fresh unchanged queries without authorizing a stale apply", async () => {
  const f = await fixture(); f.component.setLayout("grid");
  f.scenes.view.set({ phase: "stale", scene: null });
  expect(f.component.editable()).toBe(true); f.component.setFit(source, "cover");
  expect(f.component.canApply()).toBe(false); await f.component.apply();
  expect(f.scenes.controller.apply).not.toHaveBeenCalled();
  f.next({ ...state, observedAt: state.observedAt + 6000 }); await f.component.refresh();
  expect(f.component.layout()).toBe("grid"); expect(f.component.fits()[source]).toBe("cover");
  expect(f.component.dirty()).toBe(true); expect(f.component.canApply()).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true); await f.component.apply();
  expect(f.scenes.controller.apply).toHaveBeenCalledExactlyOnceWith(draft, "user-action");
});

it("a new revision needs an explicit review and separate apply confirmation, never an automatic retry", async () => {
  const f = await fixture(); f.component.setLayout("grid");
  f.next({ ...state, sceneRevision: 2, layout: "side-by-side" }); await f.component.refresh();
  expect(f.component.draftConflict()).toBe(true); expect(f.component.canApply()).toBe(false);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  f.component.reviewDraft(true); expect(f.component.draftConflict()).toBe(true);
  confirm.mockReturnValue(true); f.component.reviewDraft(true);
  expect(f.component.draftConflict()).toBe(false); expect(f.component.layout()).toBe("grid");
  expect(f.scenes.controller.apply).not.toHaveBeenCalled();
  await f.component.apply(); expect(confirm).toHaveBeenCalledTimes(3);
  expect(f.scenes.controller.apply).toHaveBeenCalledExactlyOnceWith({ ...draft, expectedSceneRevision: 2, sourceFits: ["contain"] }, "user-action");
});

it("revoked slots remain removable but cannot be applied after rechecking", async () => {
  const f = await fixture(); f.component.setLayout("grid");
  f.next({ ...state, availableSources: [] }); await f.component.refresh();
  expect(f.component.selected()).toEqual([source]); expect(f.component.canApply()).toBe(false);
  await f.component.apply(); expect(f.scenes.controller.apply).not.toHaveBeenCalled();
  f.component.remove(source); expect(f.component.fits()).toEqual({});
  expect(f.component.canApply()).toBe(true);
});

it("owner loss hides and disables the draft, and a different owner never inherits it", async () => {
  const f = await fixture(); f.component.setLayout("grid");
  f.owner.set(null); expect(f.component.formState()).toBe(null); expect(f.component.editable()).toBe(false);
  await f.component.apply(); expect(f.scenes.controller.apply).not.toHaveBeenCalled();
  f.owner.set("human-session-beta"); expect(f.component.formState()).toBe(null);
  await f.component.refresh(); expect(f.component.layout()).toBe("single"); expect(f.component.dirty()).toBe(false);
});

it("a fresh reply for a changed owner is never copied from the previous request", async () => {
  const f = await fixture();
  f.scenes.controller.refresh.mockImplementationOnce(async () => { f.owner.set("human-session-beta"); });
  await f.component.refresh(); expect(f.component.formState()).toBe(null); expect(f.component.canApply()).toBe(false);
});

it("discard requires confirmation and review is fenced across a confirmation-time owner change", async () => {
  const f = await fixture(); f.component.setLayout("grid");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  f.component.reviewDraft(false); expect(f.component.layout()).toBe("grid");
  confirm.mockReturnValue(true); f.component.reviewDraft(false); expect(f.component.layout()).toBe("single");
  f.component.setLayout("grid");
  confirm.mockImplementation(() => { f.owner.set("human-session-beta"); return true; });
  f.component.reviewDraft(true); expect(f.component.formState()).toBe(null);
  expect(f.scenes.controller.apply).not.toHaveBeenCalled();
});

it("deselection removes fit state and source order is part of the dirty presentation", async () => {
  const f = await fixture();
  f.next({ ...state, availableSources: [...state.availableSources, { sourceLeaseId: second, sourceKind: "screen" }] });
  await f.component.refresh(); f.component.select(second, true); f.component.setFit(second, "cover");
  f.component.select(second, false); expect(f.component.fits()).toEqual({ [source]: "contain" });
  expect(f.component.dirty()).toBe(false);
  const ordered = { ...state, sourceLeaseIds: [source, second], sourceFits: ["contain", "cover"] as const };
  expect(sceneDraftRefresh(ordered, { ...ordered }, { ...draft, layout: "single", sourceLeaseIds: [second, source], sourceFits: ["cover", "contain"] })).toBe("retain");
});

it("apply confirmation cannot move a draft to another owner or a newly observed state", async () => {
  for (const changed of ["owner", "observation", "stale"]) {
    const f = await fixture(); f.component.setLayout("grid");
    vi.spyOn(window, "confirm").mockImplementation(() => {
      if (changed === "owner") f.owner.set("human-session-beta");
      else f.scenes.view.set(changed === "stale" ? { phase: "stale", scene: null }
        : { phase: "ready", scene: { ...state } });
      return true;
    });
    await f.component.apply(); expect(f.scenes.controller.apply).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
});
