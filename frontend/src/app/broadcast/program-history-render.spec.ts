import "@angular/compiler";
import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ProgramHistoryComponent, PROGRAM_HISTORY_TEMPLATE } from "./program-history.component";
const platform = platformBrowserTesting(); TestBed.initTestEnvironment(BrowserTestingModule, platform);
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
afterAll(() => { TestBed.resetTestEnvironment(); platform.destroy(); });
it("renders actual Angular controls with focus, explicit load, handoff distinctions and session cleanup", async () => {
  const program = { programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 2, programRevision: 4 };
  const session = signal<string | null>("session"); let now = 10; vi.spyOn(performance, "now").mockImplementation(() => now);
  const programs = { historyContext: () => session() ? { key: session(), program } : null };
  const api = { programHistory: vi.fn(async () => ({ version: 3, ...program, observedAt: 1800000000000, expiresAt: 1800000005000,
    complete: false, retentionMs: 900000, events: [{ kind: "handoff-assigned", state: "preparing", programEpoch: 2,
      programRevision: 4, occurredAt: 1799999999000, standbyCount: 0, sourceKind: null, reason: null, controlRevision: null }] })) };
  class Rendered extends ProgramHistoryComponent { constructor() { super(programs as never, api as never); } }
  Component({ selector: "test-program-history", standalone: true, template: PROGRAM_HISTORY_TEMPLATE })(Rendered);
  await TestBed.configureTestingModule({ imports: [Rendered], providers: [provideZonelessChangeDetection()] }).compileComponents();
  const fixture = TestBed.createComponent(Rendered), root: HTMLElement = fixture.nativeElement;
  fixture.detectChanges(); expect(api.programHistory).not.toHaveBeenCalled();
  const button = root.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(false); button.focus(); expect(document.activeElement).toBe(button);
  button.click(); await fixture.whenStable();
  expect(root.querySelector("ol")?.textContent).toContain("noch keine Ausgabebestätigung");
  const base = fixture.componentInstance.view().value!.events[0];
  for (const [patch, expected] of [
    [{ kind: "source-consented", sourceKind: "screen-audio" }, "Bildschirmton: Broadcast-Zustimmung erteilt"],
    [{ kind: "source-revoked", sourceKind: "microphone", reason: "user-revoked" }, "Mikrofon: Freigabe widerrufen – durch Publisher"],
    [{ kind: "scene-applied", controlRevision: 7 }, "Szenenrevision 7"],
    [{ kind: "audio-applied", controlRevision: 8 }, "Audiorevision 8"],
    [{ kind: "source-requested", sourceKind: "camera", reason: "invited" }, "Kamera: Teilnehmer eingeladen (noch keine Zustimmung)"],
    [{ kind: "source-requested", sourceKind: "screen", reason: "own-source" }, "Bildschirm: eigene Quelle angefragt"],
    [{ kind: "source-request-closed", sourceKind: "screen-audio", reason: "declined" }, "Bildschirmton: Einladung vom Teilnehmer abgelehnt"],
    [{ kind: "source-request-closed", sourceKind: "camera", reason: "cancelled" }, "Einladung vom Sendungsinhaber zurückgezogen"],
    [{ kind: "source-request-closed", sourceKind: "camera", reason: "invalidated" }, "hinfällig"],
    [{ kind: "scene-rejected" }, "Layoutänderung vom Agenten abgewiesen"],
    [{ kind: "audio-rejected" }, "Audioänderung vom Agenten abgewiesen"],
  ] as const) expect(fixture.componentInstance.eventText({ ...base, ...patch })).toContain(expected);
  expect(root.textContent).toContain("kein vollständiges oder dauerhaftes Audit");
  now = 5010; fixture.componentInstance.controller.tick(); await fixture.whenStable();
  expect(root.querySelector("ol")).toBeNull(); expect(root.textContent).toContain("Momentaufnahme veraltet");
  button.click(); await fixture.whenStable(); expect(root.querySelectorAll("li")).toHaveLength(1);
  session.set(null); await fixture.whenStable(); expect(root.querySelector("ol")).toBeNull(); expect(button.disabled).toBe(true);
  fixture.destroy(); expect(api.programHistory).toHaveBeenCalledTimes(2);
});
