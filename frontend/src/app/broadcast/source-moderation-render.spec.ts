import "@angular/compiler";
import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { SourceModerationComponent, SOURCE_MODERATION_TEMPLATE } from "./source-moderation.component";
import { SourceModerationController, SourceModerationView } from "./source-moderation-controller";

const platform = platformBrowserTesting();
TestBed.initTestEnvironment(BrowserTestingModule, platform);
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
afterAll(() => { TestBed.resetTestEnvironment(); platform.destroy(); });

it("renders source metadata on demand, requires confirmation and rechecks freshness after the dialog", async () => {
  const now = Date.now(), sent: any[] = [];
  let time = 0;
  const view = signal<SourceModerationView>({ phase: "idle", state: null });
  const context = { key: "owner", programId: "prg_" + "a".repeat(16), programEpoch: 1 };
  const controller = new SourceModerationController({ context: () => context, send: message => { sent.push(message); },
    changed: value => view.set(value), monotonic: () => time, wall: () => now + time });
  const moderation = { view, controller, programs: { sceneContext: () => context, publisherName: () => "Synthetic publisher" } };
  class Rendered extends SourceModerationComponent { constructor() { super(moderation as never); } }
  Component({ selector: "test-source-moderation", standalone: true, template: SOURCE_MODERATION_TEMPLATE })(Rendered);
  await TestBed.configureTestingModule({ imports: [Rendered], providers: [provideZonelessChangeDetection()] }).compileComponents();
  const fixture = TestBed.createComponent(Rendered), root: HTMLElement = fixture.nativeElement;
  fixture.detectChanges(); expect(sent).toHaveLength(0); expect(root.querySelector("article")).toBeNull();
  const query = root.querySelector<HTMLButtonElement>("#source-moderation-query")!;
  query.focus(); expect(document.activeElement).toBe(query); query.click(); await fixture.whenStable();
  expect(sent).toHaveLength(1); expect(query.disabled).toBe(true);
  const respond = () => controller.receive({ ...sent.at(-1), type: "broadcast-source-moderation-state", programRevision: 4,
    fencingRevision: 2, observedAt: now + time, expiresAt: now + time + 5000, sources: [{ consentId: "cns_" + "a".repeat(16),
      sourceId: "src_" + "a".repeat(16), sourceKind: "camera", publisherPeerId: "b".repeat(16), expiresAt: now + 20000 }] });
  respond(); await fixture.whenStable(); expect(root.textContent).toContain("Synthetic publisher");
  expect(root.textContent).toContain("noch keinen Bild- oder Tonempfang");
  let remove = root.querySelector<HTMLButtonElement>("article button")!;
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  remove.focus(); expect(document.activeElement).toBe(remove); remove.click(); expect(sent).toHaveLength(1);
  confirm.mockImplementation(() => { time = 5000; return true; }); remove.click();
  await fixture.whenStable(); expect(sent).toHaveLength(1); expect(root.querySelector("article")).toBeNull();
  query.click(); respond(); await fixture.whenStable(); confirm.mockReturnValue(true);
  remove = root.querySelector<HTMLButtonElement>("article button")!; remove.click();
  await fixture.whenStable(); expect(sent).toHaveLength(3); expect(sent.at(-1).type).toBe("broadcast-source-moderation-revoke");
  expect(root.textContent).toContain("Widerruf wird angefordert");
  fixture.destroy(); controller.destroy();
});
