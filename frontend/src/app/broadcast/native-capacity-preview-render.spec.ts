import "@angular/compiler";
import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { NativeCapacityPreviewComponent, NATIVE_CAPACITY_PREVIEW_TEMPLATE } from "./native-capacity-preview.component";
const platform = platformBrowserTesting();
TestBed.initTestEnvironment(BrowserTestingModule, platform);
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
afterAll(() => { TestBed.resetTestEnvironment(); platform.destroy(); });

it.each([1, 2])("renders preview v%s and separate audio/video demand only after a click, then removes stale values", async version => {
  const session = signal<string | null>("session-one");
  const programs = { capacityContext: () => session(), previewCapacity: vi.fn(async () => ({
    schema: `ananta.native-capacity-preview.v${version}`, ...(version === 2 ? { programSlots: "available" } : {}),
    reserved: false, costStatus: "unknown", observedAt: 1800000000000,
    expiresAt: 1800000005000, requestedRenditions: 3, reduced: true, videoEncoder: "libx264",
    demand: { cpuUnits: 4, memoryMiB: 224, encoderSlots: 1, gpuSlots: 0, egressBitsPerSecond: 648600 },
    renditions: [{ id: "low", width: 640, height: 360, framesPerSecond: 15, videoBitsPerSecond: 500000, audioBitsPerSecond: 64000, audioChannels: 2 }],
  })) };
  class Rendered extends NativeCapacityPreviewComponent { constructor() { super(programs as never); } }
  Component({ selector: "test-native-capacity", standalone: true, template: NATIVE_CAPACITY_PREVIEW_TEMPLATE })(Rendered);
  await TestBed.configureTestingModule({ imports: [Rendered], providers: [provideZonelessChangeDetection()] }).compileComponents();
  const fixture = TestBed.createComponent(Rendered), root: HTMLElement = fixture.nativeElement;
  // Inherited signal inputs under the production component's template.
  const request = signal<any>(null); Object.assign(fixture.componentInstance, { request });
  fixture.detectChanges(); const button = root.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(true); expect(programs.previewCapacity).not.toHaveBeenCalled();
  request.set({ roomId: "room-alpha", packagerId: "pkr_aaaaaaaaaaaaaaaa", requestedRenditions: 3 });
  await fixture.whenStable(); expect(button.disabled).toBe(false); expect(programs.previewCapacity).not.toHaveBeenCalled();
  button.focus(); expect(document.activeElement).toBe(button);
  button.click(); await fixture.whenStable();
  expect(programs.previewCapacity).toHaveBeenCalledTimes(1);
  expect(root.textContent).toContain("1 von 3"); expect(root.textContent).toContain("640 × 360");
  expect(root.textContent).toContain("Video 500.0 kbit/s"); expect(root.textContent).toContain("Audio 64.0 kbit/s");
  expect(root.textContent).toContain("Kosten: nicht berechenbar"); expect(root.textContent).toContain("Keine Reservierung");
  expect(root.textContent).toContain(version === 2 ? "Programmlimits für einen zusätzlichen Start geprüft" : "Programmlimits wurden nicht geprüft");
  session.set(null); await fixture.whenStable();
  expect(root.textContent).toContain("Vorschau veraltet"); expect(root.querySelector("li")).toBeNull();
  fixture.destroy(); expect(programs.previewCapacity).toHaveBeenCalledTimes(1);
});
