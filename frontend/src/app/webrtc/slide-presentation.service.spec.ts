import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import { encodeSlideEvent } from "./slide-presentation-contract";
import { SlidePresentationService } from "./slide-presentation.service";
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
    presenterPeerId: signal(options?.presenterPeerId ?? ""),
    participants: signal([
      { peerId: "aaaaaaaaaaaaaaaa", role: options?.ownRole ?? "owner" },
      { peerId: "bbbbbbbbbbbbbbbb", role: "participant" },
    ]),
  } as unknown as RoomModerationService;

  const whiteboard = {
    ops: signal([]),
  } as unknown as WhiteboardOverlayService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SlidePresentationService,
        useFactory: () => new SlidePresentationService(mesh, session, moderation, whiteboard),
      },
    ],
  });

  const service = TestBed.inject(SlidePresentationService);
  return { service, mesh, session, moderation, whiteboard };
}

describe("SlidePresentationService", () => {
  it("initializes with single virtual blank slide", () => {
    const { service } = createService();
    expect(service.slides().length).toBe(0);
    expect(service.totalSlides()).toBe(1);
    expect(service.currentSlideIndex()).toBe(0);
  });

  it("adds blank slide and navigates forward/backward", () => {
    const { service, whiteboard } = createService();
    // addBlankSlide from empty initializes slide 1 & slide 2, navigating to slide 2
    service.addBlankSlide();
    expect(service.slides().length).toBe(2);
    expect(service.totalSlides()).toBe(2);
    expect(service.currentSlideIndex()).toBe(1);

    // Save annotations on slide 1
    whiteboard.ops.set([
      {
        version: 1,
        type: "whiteboard-op",
        opId: "1".repeat(32),
        membershipEpoch: 2,
        authorPeerId: "aaaaaaaaaaaaaaaa",
        kind: "shape",
        payload: { shape: "line", color: "ink", width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
      },
    ]);

    // Go back to slide 0
    service.prevSlide();
    expect(service.currentSlideIndex()).toBe(0);
    // Annotations on slide 0 are empty
    expect(whiteboard.ops().length).toBe(0);

    // Go forward to slide 1
    service.nextSlide();
    expect(service.currentSlideIndex()).toBe(1);
    // Annotations on slide 1 restored
    expect(whiteboard.ops().length).toBe(1);
  });

  it("ingests change-slide event from authorized presenter", () => {
    const { service, whiteboard } = createService({
      ownRole: "participant",
      presenterPeerId: "bbbbbbbbbbbbbbbb",
    });

    const event = {
      version: 1 as const,
      type: "slide-event" as const,
      opId: "a".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      action: "change-slide" as const,
      slideIndex: 3,
      totalSlides: 5,
    };

    const delivery = {
      id: 1,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event",
      data: encodeSlideEvent(event),
    };

    const ingested = service.ingest(delivery);
    expect(ingested).toBe(true);
    expect(service.currentSlideIndex()).toBe(3);
    expect(service.totalSlides()).toBe(5);
  });

  it("rejects slide event from unauthorized participant", () => {
    const { service } = createService({
      ownRole: "participant",
      presenterPeerId: "aaaaaaaaaaaaaaaa", // 'a' is presenter, 'b' is regular participant
    });

    const unauthEvent = {
      version: 1 as const,
      type: "slide-event" as const,
      opId: "b".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      action: "change-slide" as const,
      slideIndex: 1,
      totalSlides: 3,
    };

    const delivery = {
      id: 2,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event",
      data: encodeSlideEvent(unauthEvent),
    };

    expect(service.ingest(delivery)).toBe(false);
    expect(service.currentSlideIndex()).toBe(0);
  });

  it("assembles chunked slide image from peer", () => {
    const { service } = createService({
      ownRole: "participant",
      presenterPeerId: "bbbbbbbbbbbbbbbb",
    });

    const part1 = {
      version: 1 as const,
      type: "slide-event" as const,
      opId: "c".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      action: "slide-image-chunk" as const,
      slideIndex: 0,
      chunkIndex: 0,
      totalChunks: 2,
      mimeType: "image/jpeg" as const,
      data: "AQID",
    };

    const part2 = {
      version: 1 as const,
      type: "slide-event" as const,
      opId: "d".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      action: "slide-image-chunk" as const,
      slideIndex: 0,
      chunkIndex: 1,
      totalChunks: 2,
      mimeType: "image/jpeg" as const,
      data: "BAUG",
    };

    service.ingest({ id: 3, originPeerId: "bbbbbbbbbbbbbbbb", trafficClass: "event", data: encodeSlideEvent(part1) });
    expect(service.slides().length).toBe(0); // not yet complete

    service.ingest({ id: 4, originPeerId: "bbbbbbbbbbbbbbbb", trafficClass: "event", data: encodeSlideEvent(part2) });
    expect(service.slides().length).toBe(1);
    expect(service.slides()[0].dataUrl).toBe("data:image/jpeg;base64,AQIDBAUG");
  });
});
