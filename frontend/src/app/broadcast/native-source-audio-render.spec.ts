import "@angular/compiler";
import { readFileSync } from "node:fs";
import { ChangeDetectorRef, Component, inject, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { NativeAudioState } from "./native-source-audio-contract";
import { NativeAudioView } from "./native-source-audio-controller";
import { NativeSourceAudioComponent } from "./native-source-audio.component";

const platform = platformBrowserTesting();
TestBed.initTestEnvironment(BrowserTestingModule, platform);
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
afterAll(() => { TestBed.resetTestEnvironment(); platform.destroy(); });

it("renders current audio drafts, restores invalid inputs and synchronously gates refresh/apply", async () => {
  const source = "sls_aaaaaaaaaaaaaaaa", owner = signal<string | null>("owner-alpha");
  const state: NativeAudioState = { audioControlVersion: 2, outcome: "observed", observedAt: 1800000000000,
    programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1, packagerId: "pkr_aaaaaaaaaaaaaaaa",
    assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 1, audioRevision: 1,
    sources: [{ sourceLeaseId: source, sourceKind: "microphone", leftGainQ15: 32768, rightGainQ15: 32768, muted: false }],
    mix: { strategy: "balanced", microphoneGainQ15: 32768, screenAudioGainQ15: 32768, limiterGainQ15: 32768, peakQ15: 0 },
    encoding: { codec: "aac", sampleRate: 48000, channels: 2, renditions: [{ id: "low", targetBitsPerSecond: 64000 }] } };
  let next = state;
  const audio = { ownerKey: () => owner(), view: signal<NativeAudioView>({ phase: "idle", audio: null }), controller: {
    refresh: vi.fn(async () => { audio.view.set({ phase: "ready", audio: next }); }), apply: vi.fn(async () => {}),
  } };
  const template = readFileSync("frontend/src/app/broadcast/native-source-audio.component.html", "utf8");
  TestBed.overrideComponent(NativeSourceAudioComponent, { set: { templateUrl: undefined, template } });
  await TestBed.compileComponents();
  class RenderedAudio extends NativeSourceAudioComponent { constructor() { super(audio as never, inject(ChangeDetectorRef)); } }
  Component({ selector: "test-native-audio", standalone: true, template })(RenderedAudio);
  await TestBed.configureTestingModule({ imports: [RenderedAudio], providers: [provideZonelessChangeDetection()] }).compileComponents();
  const fixture = TestBed.createComponent(RenderedAudio), root: HTMLElement = fixture.nativeElement;
  const element = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  fixture.detectChanges(); expect(root.querySelector("fieldset")).toBe(null);
  element<HTMLButtonElement>("#native-audio-refresh").click(); await fixture.whenStable();
  const gain = element<HTMLInputElement>('input[type="number"]'), strategy = element<HTMLSelectElement>("#native-audio-strategy");
  gain.value = "50"; gain.dispatchEvent(new Event("change", { bubbles: true }));
  strategy.value = "speech-first"; strategy.dispatchEvent(new Event("change", { bubbles: true })); await fixture.whenStable();
  expect(root.querySelector("#native-audio-draft-status")).not.toBe(null);
  for (const invalid of ["200", "", "-1"]) {
    gain.value = invalid; gain.dispatchEvent(new Event("change", { bubbles: true }));
    expect(gain.value).toBe("50"); expect(fixture.componentInstance.levels()[0].leftGainQ15).toBe(16384);
  }
  let finish!: () => void;
  audio.controller.refresh.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finish = resolve; }); audio.view.set({ phase: "ready", audio: next });
  });
  element<HTMLButtonElement>("#native-audio-refresh").click();
  const refreshWasEditable = !element<HTMLFieldSetElement>("fieldset").disabled;
  if (refreshWasEditable) { strategy.value = "screen-first"; strategy.dispatchEvent(new Event("change", { bubbles: true })); }
  finish(); await fixture.whenStable(); expect(refreshWasEditable).toBe(false);
  expect(strategy.value).toBe(fixture.componentInstance.strategy()); expect(strategy.value).toBe("speech-first"); expect(gain.value).toBe("50");
  audio.view.set({ phase: "stale", audio: null }); await fixture.whenStable();
  expect(element<HTMLFieldSetElement>("fieldset").disabled).toBe(false); expect(element<HTMLButtonElement>("#native-audio-apply").disabled).toBe(true);
  next = { ...state, audioRevision: 2 }; element<HTMLButtonElement>("#native-audio-refresh").click(); await fixture.whenStable();
  expect(root.querySelector("#native-audio-draft-conflict")).not.toBe(null);
  expect(element<HTMLButtonElement>("#native-audio-apply").disabled).toBe(true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  element<HTMLButtonElement>("#native-audio-draft-review").click(); await fixture.whenStable();
  expect(audio.controller.apply).not.toHaveBeenCalled();
  let finishApply!: () => void;
  audio.controller.apply.mockImplementationOnce(async () => {
    audio.view.set({ phase: "pending", audio: null }); await new Promise<void>(resolve => { finishApply = resolve; });
    audio.view.set({ phase: "stale", audio: null });
  });
  element<HTMLButtonElement>("#native-audio-apply").click();
  const applyWasEditable = !element<HTMLFieldSetElement>("fieldset").disabled;
  if (applyWasEditable) { strategy.value = "unprocessed"; strategy.dispatchEvent(new Event("change", { bubbles: true })); }
  finishApply(); await fixture.whenStable(); expect(applyWasEditable).toBe(false);
  expect(strategy.value).toBe(fixture.componentInstance.strategy()); expect(confirm).toHaveBeenCalledTimes(2);
  expect(audio.controller.apply).toHaveBeenCalledExactlyOnceWith({ expectedAudioRevision: 2, strategy: "speech-first",
    sources: [{ sourceLeaseId: source, leftGainQ15: 16384, rightGainQ15: 32768, muted: false }] }, "user-action");
  owner.set(null); await fixture.whenStable(); expect(root.querySelector("fieldset")).toBe(null);
});
