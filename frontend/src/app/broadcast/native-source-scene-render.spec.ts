import "@angular/compiler";
import { readFileSync } from "node:fs";
import { ChangeDetectorRef, Component, inject, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { NativeSceneState } from "./native-source-scene-contract";
import { NativeSceneView } from "./native-source-scene-controller";
import { NativeSourceSceneComponent } from "./native-source-scene.component";

const platform = platformBrowserTesting();
TestBed.initTestEnvironment(BrowserTestingModule, platform);
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
afterAll(() => { TestBed.resetTestEnvironment(); platform.destroy(); });

it("renders scoped draft, freshness, conflict and separate review/apply controls from the real template", async () => {
  const source = "sls_aaaaaaaaaaaaaaaa";
  const state: NativeSceneState = { sceneControlVersion: 2, programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1,
    packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 1,
    outcome: "observed", observedAt: 1800000000000, sceneRevision: 1, layout: "single", sourceLeaseIds: [source],
    sourceFits: ["contain"], activeSourceLeaseId: "", availableSources: [{ sourceLeaseId: source, sourceKind: "camera" }] };
  const owner = signal<string | null>("human-session-alpha");
  const publisher = signal<string | null>("<img src=x onerror=alert(1)> Synthetic source");
  let next = state;
  const scenes = { ownerKey: () => owner(), publisherName: () => publisher(), labelsStatus: () => "Synthetic membership fixture",
    view: signal<NativeSceneView>({ phase: "idle", scene: null }), controller: {
    refresh: vi.fn(async () => { scenes.view.set({ phase: "ready", scene: next }); }), apply: vi.fn(async () => {}),
  } };
  // Only dependency construction is replaced. Template, handlers and signals
  // are the production component; the port makes no HTTP or media requests.
  const template = readFileSync("frontend/src/app/broadcast/native-source-scene.component.html", "utf8");
  TestBed.overrideComponent(NativeSourceSceneComponent, { set: { templateUrl: undefined, template } });
  await TestBed.compileComponents();
  class RenderedScene extends NativeSourceSceneComponent { constructor() { super(scenes as never, inject(ChangeDetectorRef)); } }
  Component({ selector: "test-native-scene", standalone: true, template })(RenderedScene);
  await TestBed.configureTestingModule({ imports: [RenderedScene], providers: [provideZonelessChangeDetection()] }).compileComponents();
  const fixture = TestBed.createComponent(RenderedScene), root: HTMLElement = fixture.nativeElement;
  const element = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  fixture.detectChanges(); expect(root.querySelector("fieldset")).toBe(null);
  element<HTMLButtonElement>("#native-scene-refresh").click(); await fixture.whenStable();
  const layout = element<HTMLSelectElement>("#native-scene-layout");
  expect(layout.value).toBe("single");
  expect(root.textContent).toContain(publisher()); expect(root.querySelector("img")).toBe(null);
  publisher.set(null); await fixture.whenStable(); expect(root.textContent).not.toContain("onerror");
  expect(root.textContent).toContain("Teilnehmer nicht zugeordnet");
  // A completed input event is not an observation of Angular's next render.
  const checkbox = element<HTMLInputElement>('input[type="checkbox"]');
  checkbox.click(); await fixture.whenStable();
  expect(root.querySelectorAll("select[data-scene-fit]").length).toBe(0);
  checkbox.click();
  expect(fixture.componentInstance.selected()).toEqual([source]);
  expect(root.querySelectorAll("select[data-scene-fit]").length).toBe(0);
  await fixture.whenStable();
  expect(Array.from(root.querySelectorAll<HTMLSelectElement>("select[data-scene-fit]"), node => node.value)).toEqual(["contain"]);
  // A refresh begins synchronously, before Angular's next scheduled render.
  // A native select interaction must not appear accepted while its handler is gated.
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  scenes.controller.refresh.mockImplementationOnce(async () => { await pending; scenes.view.set({ phase: "ready", scene: next }); });
  element<HTMLButtonElement>("#native-scene-refresh").click();
  const pendingWasEditable = !element<HTMLFieldSetElement>("fieldset").disabled;
  if (pendingWasEditable) { layout.value = "grid"; layout.dispatchEvent(new Event("change", { bubbles: true })); }
  finish(); await fixture.whenStable();
  expect(layout.value).toBe(fixture.componentInstance.layout());
  expect(pendingWasEditable).toBe(false);
  layout.value = "grid"; layout.dispatchEvent(new Event("change", { bubbles: true })); await fixture.whenStable();
  expect(root.querySelector("#native-scene-draft-status")).not.toBe(null);
  scenes.view.set({ phase: "stale", scene: null }); await fixture.whenStable();
  expect(element<HTMLFieldSetElement>("fieldset").disabled).toBe(false);
  expect(element<HTMLButtonElement>("#native-scene-apply").disabled).toBe(true);
  element<HTMLButtonElement>("#native-scene-refresh").click(); await fixture.whenStable();
  expect(layout.value).toBe("grid"); expect(element<HTMLButtonElement>("#native-scene-apply").disabled).toBe(false);
  next = { ...state, sceneRevision: 2, layout: "side-by-side" };
  element<HTMLButtonElement>("#native-scene-refresh").click(); await fixture.whenStable();
  expect(root.querySelector("#native-scene-draft-conflict")).not.toBe(null);
  expect(element<HTMLButtonElement>("#native-scene-apply").disabled).toBe(true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  element<HTMLButtonElement>("#native-scene-draft-review").click(); await fixture.whenStable();
  expect(root.querySelector("#native-scene-draft-conflict")).toBe(null);
  expect(scenes.controller.apply).not.toHaveBeenCalled();
  let finishApply!: () => void;
  const applyPending = new Promise<void>(resolve => { finishApply = resolve; });
  scenes.controller.apply.mockImplementationOnce(async () => {
    scenes.view.set({ phase: "pending", scene: null }); await applyPending;
    scenes.view.set({ phase: "stale", scene: null });
  });
  element<HTMLButtonElement>("#native-scene-apply").click();
  const applyWasEditable = !element<HTMLFieldSetElement>("fieldset").disabled;
  if (applyWasEditable) { layout.value = "end-slate"; layout.dispatchEvent(new Event("change", { bubbles: true })); }
  finishApply(); await fixture.whenStable();
  expect(layout.value).toBe(fixture.componentInstance.layout()); expect(applyWasEditable).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(scenes.controller.apply).toHaveBeenCalledExactlyOnceWith({ expectedSceneRevision: 2, layout: "grid", sourceLeaseIds: [source],
    sourceFits: ["contain"], activeSourceLeaseId: "" }, "user-action");
  owner.set(null); await fixture.whenStable(); expect(root.querySelector("fieldset")).toBe(null);
});
