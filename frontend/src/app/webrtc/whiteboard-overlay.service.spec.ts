import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import { SignalingService } from "./signaling.service";
import { decodeWhiteboardBytes, encodeWhiteboardOperation } from "./whiteboard-contract";
import { WhiteboardOverlayService } from "./whiteboard-overlay.service";

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
} catch {
  // Already initialized
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

function createService(options?: {
  ownRole?: string;
  ownPresenter?: boolean;
  whiteboardPolicy?: "open" | "presenter-only";
  presenterPeerId?: string;
  joined?: boolean;
}) {
  const mesh = {
    peerChoices: signal([{ id: "bbbbbbbbbbbbbbbb" }]),
    membershipEpoch: signal(2),
    overlayDeliveries: signal([]),
    machineReceive: { isMachine: () => false },
    sendOverlayData: vi.fn(async () => true),
  } as unknown as PeerMeshService;

  const session = {
    joined: signal(options?.joined ?? true),
    peerId: signal("aaaaaaaaaaaaaaaa"),
  } as unknown as RoomSessionService;

  const moderation = {
    ownRole: signal(options?.ownRole ?? "owner"),
    ownPresenter: signal(options?.ownPresenter ?? false),
    whiteboardPolicy: signal(options?.whiteboardPolicy ?? "open"),
    presenterPeerId: signal(options?.presenterPeerId ?? ""),
    participants: signal([
      { peerId: "aaaaaaaaaaaaaaaa", role: options?.ownRole ?? "owner" },
      { peerId: "bbbbbbbbbbbbbbbb", role: "participant" },
    ]),
  } as unknown as RoomModerationService;

  const signaling = {
    subscribe: vi.fn(() => () => {}),
    send: vi.fn(),
  } as unknown as SignalingService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: WhiteboardOverlayService,
        useFactory: () => new WhiteboardOverlayService(mesh, session, moderation, signaling),
      },
    ],
  });

  const service = TestBed.inject(WhiteboardOverlayService);
  return { service, mesh, session, moderation, signaling };
}

describe("WhiteboardOverlayService", () => {
  it("publishes shapes and text to peers over overlay", () => {
    const { service, mesh } = createService();

    const shapeOk = service.publish("shape", {
      shape: "rectangle",
      color: "accent",
      width: 2,
      start: { x: 10, y: 10 },
      end: { x: 50, y: 50 },
    });
    expect(shapeOk).toBe(true);
    expect(service.ops().length).toBe(1);
    expect(service.ops()[0].kind).toBe("shape");
    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);

    const textOk = service.publish("text", {
      text: "WebRTC Test",
      point: { x: 100, y: 100 },
      color: "mark",
      size: 16,
    });
    expect(textOk).toBe(true);
    expect(service.ops().length).toBe(2);
    expect(service.ops()[1].kind).toBe("text");
    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(2);

    // Rejects publishing sync messages directly via publish
    expect(service.publish("sync-request", {})).toBe(false);
    expect(service.publish("sync-response", { ops: [] })).toBe(false);
  });

  it("handles sync-request by returning bounded sync-response to requester", () => {
    const { service, mesh } = createService({ ownRole: "owner" });
    service.publish("shape", {
      shape: "line",
      color: "ink",
      width: 2,
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    });

    const reqOp = {
      version: 1 as const,
      type: "whiteboard-op" as const,
      opId: "f".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "sync-request" as const,
      payload: {},
    };
    const reqDelivery = {
      id: 1,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event" as const,
      data: encodeWhiteboardOperation(reqOp),
    };

    const ingested = service.ingest(reqDelivery);
    expect(ingested).toBe(true);
    // sync-request should NOT be appended to ops
    expect(service.ops().length).toBe(1);
    // Peer should have sent sync-response to origin
    const calls = vi.mocked(mesh.sendOverlayData).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe("bbbbbbbbbbbbbbbb");
    expect(lastCall[2]).toBe("event");
    const decoded = decodeWhiteboardBytes(lastCall[1]);
    expect(decoded?.kind).toBe("sync-response");
    expect((decoded?.payload as { ops: unknown[] })?.ops?.length).toBe(1);
  });

  it("handles sync-response by unpacking and deduplicating operations", () => {
    const { service } = createService({ ownRole: "participant" });
    expect(service.ops().length).toBe(0);

    const remoteOp = {
      version: 1 as const,
      type: "whiteboard-op" as const,
      opId: "c".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "shape" as const,
      payload: {
        shape: "ellipse" as const,
        color: "accent" as const,
        width: 3,
        start: { x: 5, y: 5 },
        end: { x: 25, y: 25 },
      },
    };

    const respOp = {
      version: 1 as const,
      type: "whiteboard-op" as const,
      opId: "d".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "sync-response" as const,
      payload: { ops: [remoteOp] },
    };

    const delivery = {
      id: 2,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event" as const,
      data: encodeWhiteboardOperation(respOp),
    };

    const ingested = service.ingest(delivery);
    expect(ingested).toBe(true);
    expect(service.ops().length).toBe(1);
    expect(service.ops()[0].opId).toBe(remoteOp.opId);

    // Redelivery deduplicates and does not duplicate
    const redelivery = service.ingest(delivery);
    // Seen opId causes delivery to be ignored
    expect(redelivery).toBe(false);
    expect(service.ops().length).toBe(1);
  });

  it("resets state completely on leave", () => {
    const { service } = createService();
    service.publish("shape", {
      shape: "rectangle",
      color: "ink",
      width: 2,
      start: { x: 1, y: 1 },
      end: { x: 2, y: 2 },
    });
    expect(service.ops().length).toBe(1);
    service.reset();
    expect(service.ops().length).toBe(0);
  });

  it("enforces presenter-only access control on publish and ingest", () => {
    // 1. Participant in presenter-only cannot publish
    const { service: guestService } = createService({
      ownRole: "participant",
      whiteboardPolicy: "presenter-only",
      presenterPeerId: "cccccccccccccccc",
    });
    expect(guestService.canDraw()).toBe(false);
    expect(guestService.publish("shape", {
      shape: "rectangle",
      color: "ink",
      width: 2,
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })).toBe(false);

    // 2. Presenter in presenter-only CAN publish
    const { service: presenterService } = createService({
      ownRole: "participant",
      ownPresenter: true,
      whiteboardPolicy: "presenter-only",
      presenterPeerId: "aaaaaaaaaaaaaaaa",
    });
    expect(presenterService.canDraw()).toBe(true);
    expect(presenterService.publish("shape", {
      shape: "rectangle",
      color: "ink",
      width: 2,
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })).toBe(true);

    // 3. Ingesting drawing op from non-presenter/non-owner in presenter-only is rejected
    const unauthOp = {
      version: 1 as const,
      type: "whiteboard-op" as const,
      opId: "f".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "shape" as const,
      payload: { shape: "line" as const, color: "ink" as const, width: 2, start: { x: 0, y: 0 }, end: { x: 5, y: 5 } },
    };
    const delivery = {
      id: 10,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event" as const,
      data: encodeWhiteboardOperation(unauthOp),
    };
    expect(presenterService.ingest(delivery)).toBe(false);
  });
});

