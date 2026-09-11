import { Injectable, computed, effect, signal } from "@angular/core";

import { LoadedSlide } from "../shared/slide-deck-loader";
import { PeerMeshService, OverlayDelivery } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import {
  decodeSlideEventBytes,
  encodeSlideEvent,
  parseSlideEvent,
  SlideEvent,
} from "./slide-presentation-contract";
import { authorizedClearPeerIds } from "./whiteboard-overlay";
import { WhiteboardOverlayService } from "./whiteboard-overlay.service";
import { WhiteboardOperation } from "./whiteboard-contract";

function opId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class SlidePresentationService {
  readonly slides = signal<readonly LoadedSlide[]>([]);
  readonly currentSlideIndex = signal<number>(0);
  readonly totalSlides = computed(() => Math.max(1, this.slides().length));
  readonly currentSlide = computed(() => this.slides()[this.currentSlideIndex()] ?? null);

  readonly canControl = computed(() => {
    if (!this.session.joined()) return true;
    return this.moderation.ownRole() === "owner" || this.moderation.ownPresenter();
  });

  private readonly annotationsBySlide = new Map<number, readonly WhiteboardOperation[]>();
  private lastDelivery = 0;
  private seenOps = new Set<string>();
  private wasJoined = false;

  // Incoming chunk assembly buffer: `${authorPeerId}:${slideIndex}` -> chunks array
  private chunkBuffers = new Map<string, { chunks: (string | null)[]; total: number; mime: "image/jpeg" | "image/png" | "image/webp" }>();

  constructor(
    private readonly mesh: PeerMeshService,
    private readonly session: RoomSessionService,
    private readonly moderation: RoomModerationService,
    private readonly whiteboard: WhiteboardOverlayService,
  ) {
    effect(() => {
      const joined = this.session.joined();
      if (!joined) {
        if (this.wasJoined) {
          this.wasJoined = false;
          this.reset();
        }
        return;
      }
      this.wasJoined = true;
      for (const item of this.mesh.overlayDeliveries()) {
        if (item.id <= this.lastDelivery) continue;
        this.lastDelivery = item.id;
        this.ingest(item);
      }
    });
  }

  getSlideAnnotations(index: number): readonly WhiteboardOperation[] {
    return this.annotationsBySlide.get(index) ?? [];
  }

  saveSlideAnnotations(index: number, ops: readonly WhiteboardOperation[]): void {
    this.annotationsBySlide.set(index, ops);
  }

  goToSlide(index: number): boolean {
    if (!this.canControl()) return false;
    if (index < 0 || index >= this.totalSlides()) return false;
    if (index === this.currentSlideIndex()) return true;

    // Save current slide annotations
    this.saveSlideAnnotations(this.currentSlideIndex(), this.whiteboard.ops());

    // Switch index
    this.currentSlideIndex.set(index);

    // Load saved annotations for new slide
    const saved = this.getSlideAnnotations(index);
    this.whiteboard.ops.set(saved);

    // Broadcast change if joined
    if (this.session.joined()) {
      const event: SlideEvent = {
        version: 1,
        type: "slide-event",
        opId: opId(),
        membershipEpoch: Math.max(1, this.mesh.membershipEpoch()),
        authorPeerId: this.session.peerId() || "0123456789abcdef",
        action: "change-slide",
        slideIndex: index,
        totalSlides: this.totalSlides(),
      };
      const parsed = parseSlideEvent(event);
      if (parsed) {
        this.seenOps.add(parsed.opId);
        const bytes = encodeSlideEvent(parsed);
        for (const peer of this.mesh.peerChoices()) {
          if (this.mesh.machineReceive.isMachine(peer.id)) continue;
          void this.mesh.sendOverlayData(peer.id, bytes, "event");
        }
      }
    }
    return true;
  }

  nextSlide(): boolean {
    return this.goToSlide(this.currentSlideIndex() + 1);
  }

  prevSlide(): boolean {
    return this.goToSlide(this.currentSlideIndex() - 1);
  }

  addBlankSlide(): void {
    if (this.slides().length === 0) {
      const firstSlide: LoadedSlide = {
        id: `blank-slide-0-${Date.now().toString(16)}`,
        name: "Folie 1",
        dataUrl: "",
        mimeType: "image/png",
        width: 1280,
        height: 720,
      };
      const secondSlide: LoadedSlide = {
        id: `blank-slide-1-${Date.now().toString(16)}`,
        name: "Folie 2",
        dataUrl: "",
        mimeType: "image/png",
        width: 1280,
        height: 720,
      };
      this.slides.set(Object.freeze([firstSlide, secondSlide]));
      this.goToSlide(1);
      return;
    }
    const nextIndex = this.slides().length;
    const newSlide: LoadedSlide = {
      id: `blank-slide-${nextIndex}-${Date.now().toString(16)}`,
      name: `Folie ${nextIndex + 1}`,
      dataUrl: "",
      mimeType: "image/png",
      width: 1280,
      height: 720,
    };
    this.slides.update((items) => Object.freeze([...items, newSlide]));
    this.goToSlide(nextIndex);
  }

  loadDeck(slides: readonly LoadedSlide[]): void {
    this.annotationsBySlide.clear();
    this.slides.set(slides);
    this.currentSlideIndex.set(0);
    this.whiteboard.ops.set([]);

    if (this.session.joined() && this.canControl()) {
      const event: SlideEvent = {
        version: 1,
        type: "slide-event",
        opId: opId(),
        membershipEpoch: Math.max(1, this.mesh.membershipEpoch()),
        authorPeerId: this.session.peerId() || "0123456789abcdef",
        action: "change-slide",
        slideIndex: 0,
        totalSlides: this.totalSlides(),
      };
      const parsed = parseSlideEvent(event);
      if (parsed) {
        this.seenOps.add(parsed.opId);
        const bytes = encodeSlideEvent(parsed);
        for (const peer of this.mesh.peerChoices()) {
          if (this.mesh.machineReceive.isMachine(peer.id)) continue;
          void this.mesh.sendOverlayData(peer.id, bytes, "event");
        }
      }
    }
  }

  clearDeck(): void {
    if (!this.canControl()) return;
    this.annotationsBySlide.clear();
    this.slides.set([]);
    this.currentSlideIndex.set(0);
    this.whiteboard.ops.set([]);

    if (this.session.joined()) {
      const event: SlideEvent = {
        version: 1,
        type: "slide-event",
        opId: opId(),
        membershipEpoch: Math.max(1, this.mesh.membershipEpoch()),
        authorPeerId: this.session.peerId() || "0123456789abcdef",
        action: "clear-deck",
      };
      const parsed = parseSlideEvent(event);
      if (parsed) {
        this.seenOps.add(parsed.opId);
        const bytes = encodeSlideEvent(parsed);
        for (const peer of this.mesh.peerChoices()) {
          if (this.mesh.machineReceive.isMachine(peer.id)) continue;
          void this.mesh.sendOverlayData(peer.id, bytes, "event");
        }
      }
    }
  }

  ingest(delivery: OverlayDelivery): boolean {
    if (delivery.trafficClass !== "event") return false;
    const event = decodeSlideEventBytes(delivery.data);
    if (!event) return false;

    // Epoch & author verification
    if (event.membershipEpoch !== this.mesh.membershipEpoch()) return false;
    if (event.authorPeerId !== delivery.originPeerId) return false;
    if (this.seenOps.has(event.opId)) return false;

    // Check authority: Author must be presenter or owner
    const authorized = authorizedClearPeerIds(this.moderation.participants(), this.moderation.presenterPeerId());
    if (!authorized.has(event.authorPeerId)) return false;

    this.seenOps.add(event.opId);

    if (event.action === "change-slide") {
      // If remote has more slides than local, pad local slides with blank placeholders
      if (event.totalSlides > this.slides().length) {
        const padded = [...this.slides()];
        while (padded.length < event.totalSlides) {
          const idx = padded.length;
          padded.push({
            id: `remote-slide-${idx}`,
            name: `Folie ${idx + 1}`,
            dataUrl: "",
            mimeType: "image/png",
            width: 1280,
            height: 720,
          });
        }
        this.slides.set(Object.freeze(padded));
      }

      if (event.slideIndex < this.totalSlides()) {
        // Save previous annotations
        this.saveSlideAnnotations(this.currentSlideIndex(), this.whiteboard.ops());
        // Switch to new slide
        this.currentSlideIndex.set(event.slideIndex);
        // Load annotations for new slide
        const saved = this.getSlideAnnotations(event.slideIndex);
        this.whiteboard.ops.set(saved);
      }
      return true;
    }

    if (event.action === "clear-deck") {
      this.annotationsBySlide.clear();
      this.slides.set([]);
      this.currentSlideIndex.set(0);
      this.whiteboard.ops.set([]);
      return true;
    }

    if (event.action === "slide-image-chunk") {
      const key = `${event.authorPeerId}:${event.slideIndex}`;
      let buf = this.chunkBuffers.get(key);
      if (!buf || buf.total !== event.totalChunks) {
        buf = {
          chunks: Array(event.totalChunks).fill(null),
          total: event.totalChunks,
          mime: event.mimeType,
        };
        this.chunkBuffers.set(key, buf);
      }
      buf.chunks[event.chunkIndex] = event.data;

      // Check if all chunks received
      if (buf.chunks.every((c) => c !== null)) {
        const fullBase64 = buf.chunks.join("");
        const dataUrl = `data:${buf.mime};base64,${fullBase64}`;
        this.chunkBuffers.delete(key);

        // Update the slide
        const updatedSlides = [...this.slides()];
        while (updatedSlides.length <= event.slideIndex) {
          const idx = updatedSlides.length;
          updatedSlides.push({
            id: `remote-slide-${idx}`,
            name: `Folie ${idx + 1}`,
            dataUrl: "",
            mimeType: buf.mime,
            width: 1280,
            height: 720,
          });
        }
        updatedSlides[event.slideIndex] = {
          ...updatedSlides[event.slideIndex],
          dataUrl,
          mimeType: buf.mime,
        };
        this.slides.set(Object.freeze(updatedSlides));
      }
      return true;
    }

    return false;
  }

  reset(): void {
    this.slides.set([]);
    this.currentSlideIndex.set(0);
    this.annotationsBySlide.clear();
    this.chunkBuffers.clear();
    this.seenOps.clear();
    this.lastDelivery = 0;
  }
}
