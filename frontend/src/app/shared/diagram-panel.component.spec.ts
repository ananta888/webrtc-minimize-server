import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiagramService } from "../webrtc/diagram.service";
import { RoomModerationService } from "../webrtc/room-moderation.service";
import { RoomSessionService } from "../webrtc/room-session.service";
import { DiagramPanelComponent } from "./diagram-panel.component";

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
} catch {
  // Already initialized
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

const OWN = "aaaaaaaaaaaaaaaa";
const REMOTE = "bbbbbbbbbbbbbbbb";

function createPanel() {
  const diagram = {
    docs: signal(new Map()),
    toolState: signal(null),
    locks: signal(new Map()),
    activeTool: signal("bpmn"),
    canEdit: signal(true),
    doc: () => null,
    setTool: vi.fn(() => true),
    setLock: vi.fn(() => true),
    scheduleSnapshot: vi.fn(),
    publishSnapshot: vi.fn(() => true),
  } as unknown as DiagramService;

  const moderation = {
    diagramPolicy: signal("open"),
    canControlDiagram: signal(true),
    setDiagramPolicy: vi.fn(),
  } as unknown as RoomModerationService;

  const session = {
    joined: signal(true),
    peerId: signal(OWN),
  } as unknown as RoomSessionService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: DiagramPanelComponent,
        useFactory: () => new DiagramPanelComponent(diagram, moderation, session,
          { bypassSecurityTrustResourceUrl: (value: string) => value } as never),
      },
    ],
  });

  const component = TestBed.inject(DiagramPanelComponent);
  return { component, diagram, moderation, session };
}

describe("DiagramPanelComponent", () => {
  it("switches the room tool only for valid editor values", () => {
    const { component, diagram } = createPanel();
    component.selectTool("drawio");
    expect(diagram.setTool).toHaveBeenCalledExactlyOnceWith("drawio");
    component.selectTool("word");
    expect(diagram.setTool).toHaveBeenCalledTimes(1);
  });

  it("toggles the edit policy between open and presenter-only", () => {
    const { component, moderation } = createPanel();
    component.togglePolicy();
    expect(moderation.setDiagramPolicy).toHaveBeenCalledExactlyOnceWith("presenter-only");
    (moderation.diagramPolicy as ReturnType<typeof signal>).set("presenter-only");
    component.togglePolicy();
    expect(moderation.setDiagramPolicy).toHaveBeenLastCalledWith("open");
  });

  it("locks and unlocks only the selected element and reports the lock owner", () => {
    const { component, diagram } = createPanel();
    component.lockSelected();
    component.unlockSelected();
    expect(diagram.setLock).not.toHaveBeenCalled();

    (component as unknown as { selectedElementId: ReturnType<typeof signal> }).selectedElementId.set("Activity_1");
    (diagram.locks as ReturnType<typeof signal>).set(new Map([["Activity_1", { ownerPeerId: REMOTE, expiresAt: 1 }]]));
    expect(component.lockOwner()).toBe(REMOTE);
    component.unlockSelected();
    expect(diagram.setLock).toHaveBeenCalledExactlyOnceWith("Activity_1", false);

    (diagram.locks as ReturnType<typeof signal>).set(new Map([["Activity_1", { ownerPeerId: OWN, expiresAt: 1 }]]));
    expect(component.lockOwner()).toBe(OWN);
    component.lockSelected();
    expect(diagram.setLock).toHaveBeenLastCalledWith("Activity_1", true);
    expect(component.ownPeerId()).toBe(OWN);
  });

  it("publishes drawio autosaves and ignores foreign or duplicate messages", () => {
    const { component, diagram } = createPanel();
    (component as unknown as { drawioFrame: unknown }).drawioFrame = { nativeElement: { contentWindow: window } };

    (component as unknown as {
      onDrawioMessage(event: unknown): void;
    }).onDrawioMessage({ origin: "https://evil.example", source: window, data: JSON.stringify({ event: "autosave", xml: "<x/>" }) });
    expect(diagram.scheduleSnapshot).not.toHaveBeenCalled();

    (component as unknown as {
      onDrawioMessage(event: unknown): void;
    }).onDrawioMessage({ origin: window.location.origin, source: window, data: JSON.stringify({ event: "init" }) });
    expect(component.drawioReady()).toBe(true);

    (component as unknown as {
      onDrawioMessage(event: unknown): void;
    }).onDrawioMessage({ origin: window.location.origin, source: window, data: JSON.stringify({ event: "autosave", xml: "<mxfile a/>" }) });
    expect(diagram.scheduleSnapshot).toHaveBeenCalledExactlyOnceWith("drawio", "<mxfile a/>");

    (component as unknown as {
      onDrawioMessage(event: unknown): void;
    }).onDrawioMessage({ origin: window.location.origin, source: window, data: JSON.stringify({ event: "autosave", xml: "<mxfile a/>" }) });
    expect(diagram.scheduleSnapshot).toHaveBeenCalledTimes(1);
  });
});
