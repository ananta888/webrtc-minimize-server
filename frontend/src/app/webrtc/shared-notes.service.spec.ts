import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import { decodeSharedNotesBytes, encodeSharedNotesOperation } from "./shared-notes-contract";
import { SharedNotesService } from "./shared-notes.service";

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
} catch {
  // Already initialized
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

function createService() {
  const mesh = {
    overlayDeliveries: signal([]),
    membershipEpoch: signal(1),
    peerChoices: signal([{ id: "bbbbbbbbbbbbbbbb", name: "Bob" }]),
    sendOverlayData: vi.fn(async () => true),
    machineReceive: { isMachine: vi.fn(() => false) },
  } as unknown as PeerMeshService;

  const session = {
    joined: signal(true),
    peerId: signal("aaaaaaaaaaaaaaaa"),
    roomId: signal("test-room"),
  } as unknown as RoomSessionService;

  const moderation = {
    participants: signal([
      { peerId: "aaaaaaaaaaaaaaaa", role: "owner" },
      { peerId: "bbbbbbbbbbbbbbbb", role: "participant" },
    ]),
  } as unknown as RoomModerationService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SharedNotesService,
        useFactory: () => new SharedNotesService(mesh, session, moderation),
      },
    ],
  });

  const service = TestBed.inject(SharedNotesService);
  return { service, mesh, session, moderation };
}

describe("SharedNotesService", () => {
  it("updates text locally and broadcasts notes-update to peers", () => {
    const { service, mesh } = createService();

    const ok = service.updateText("Meeting notes item 1");
    expect(ok).toBe(true);
    expect(service.text()).toBe("Meeting notes item 1");
    expect(service.revision()).toBe(1);
    expect(service.charCount()).toBe(20);
    expect(service.isOverLimit()).toBe(false);

    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);
    const [destId, bytes, trafficClass] = vi.mocked(mesh.sendOverlayData).mock.calls[0];
    expect(destId).toBe("bbbbbbbbbbbbbbbb");
    expect(trafficClass).toBe("event");

    const decoded = decodeSharedNotesBytes(bytes);
    expect(decoded?.kind).toBe("notes-update");
    expect(decoded?.payload).toEqual({
      revision: 1,
      baseRevision: 0,
      text: "Meeting notes item 1",
    });
  });

  it("ingests notes-update from peer and updates state", () => {
    const { service } = createService();

    const remoteOp = {
      version: 1 as const,
      type: "notes-op" as const,
      opId: "c".repeat(32),
      membershipEpoch: 1,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "notes-update" as const,
      payload: {
        revision: 5,
        baseRevision: 4,
        text: "Updated text from Bob",
      },
    };

    const ingested = service.ingest({
      id: 1,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event",
      data: encodeSharedNotesOperation(remoteOp),
    });

    expect(ingested).toBe(true);
    expect(service.text()).toBe("Updated text from Bob");
    expect(service.revision()).toBe(5);
    expect(service.lastAuthorPeerId()).toBe("bbbbbbbbbbbbbbbb");
  });

  it("responds to notes-sync-request with snapshot if owner with revision > 0", () => {
    const { service, mesh } = createService();
    service.updateText("Existing note");

    vi.mocked(mesh.sendOverlayData).mockClear();

    const syncReqOp = {
      version: 1 as const,
      type: "notes-op" as const,
      opId: "d".repeat(32),
      membershipEpoch: 1,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "notes-sync-request" as const,
      payload: {},
    };

    const ingested = service.ingest({
      id: 2,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event",
      data: encodeSharedNotesOperation(syncReqOp),
    });

    expect(ingested).toBe(true);
    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);

    const [destId, bytes] = vi.mocked(mesh.sendOverlayData).mock.calls[0];
    expect(destId).toBe("bbbbbbbbbbbbbbbb");
    const decoded = decodeSharedNotesBytes(bytes);
    expect(decoded?.kind).toBe("notes-snapshot");
    expect(decoded?.payload).toEqual({
      revision: 1,
      text: "Existing note",
    });
  });

  it("resets state completely on leave", () => {
    const { service } = createService();
    service.updateText("Some note");
    expect(service.text()).toBe("Some note");

    service.reset();
    expect(service.text()).toBe("");
    expect(service.revision()).toBe(0);
    expect(service.lastAuthorPeerId()).toBe("");
  });
});
