import "@angular/compiler";
import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { PlaybackCapacityComponent, PLAYBACK_CAPACITY_TEMPLATE } from "./playback-capacity.component";
const platform = platformBrowserTesting(); TestBed.initTestEnvironment(BrowserTestingModule, platform);
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
afterAll(() => { TestBed.resetTestEnvironment(); platform.destroy(); });
it("real Angular template queries only on click and removes stale counts on input/session changes", async () => {
  const program = { programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 2, programRevision: 4 };
  const session = signal<string | null>("session");
  const programs = { sceneContext: () => session() ? { key: session(), program } : null };
  const api = { playbackCapacity: vi.fn(async (_p, n) => ({ version: 1, ...program, observedAt: 1800000000000, expiresAt: 1800000005000,
    reserved: false, programSessions: 3, programLimit: 500, perAudienceLimit: 4, additionalSessions: n, sharedBudgetsFit: true })) };
  class Rendered extends PlaybackCapacityComponent { constructor() { super(programs as never, api as never); } }
  Component({ selector: "test-playback-capacity", standalone: true, template: PLAYBACK_CAPACITY_TEMPLATE })(Rendered);
  await TestBed.configureTestingModule({ imports: [Rendered], providers: [provideZonelessChangeDetection()] }).compileComponents();
  const fixture = TestBed.createComponent(Rendered), root: HTMLElement = fixture.nativeElement;
  fixture.detectChanges(); expect(api.playbackCapacity).not.toHaveBeenCalled();
  const button = root.querySelector<HTMLButtonElement>("button")!, input = root.querySelector<HTMLInputElement>("input")!;
  button.focus(); expect(document.activeElement).toBe(button); button.click(); await fixture.whenStable();
  expect(root.textContent).toContain("3 belegte Cookie-Sitzungen"); expect(root.textContent).toContain("keine Reservierung");
  expect(root.textContent).toContain("keine Bandbreiten- oder CDN-Zusage");
  input.value = "20"; input.dispatchEvent(new Event("input", { bubbles: true })); await fixture.whenStable();
  expect(root.textContent).not.toContain("3 belegte"); expect(root.textContent).toContain("Abfrage veraltet");
  expect(api.playbackCapacity).toHaveBeenCalledTimes(1);
  button.click(); await fixture.whenStable(); expect(root.textContent).toContain("20 zusätzliche Sitzungen");
  session.set(null); await fixture.whenStable(); expect(button.disabled).toBe(true); expect(root.textContent).not.toContain("3 belegte");
  fixture.destroy(); expect(api.playbackCapacity).toHaveBeenCalledTimes(2);
});
