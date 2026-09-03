import { Injectable, OnDestroy, signal } from "@angular/core";

import {
  LocalOriginalMediaSource,
  MediaPublicationService,
} from "../webrtc/media-publication.service";
import {
  BroadcastBrowserPortError,
  BroadcastCaptureForkHandle,
  BroadcastCaptureForkPort,
  BroadcastProgramRef,
  BroadcastRoomSourceRef,
  BroadcastSourceKind,
} from "./broadcast-ports";

export interface BroadcastOwnSourceForkView extends BroadcastCaptureForkHandle {
  readonly stream: MediaStream;
}

interface OwnedFork {
  readonly view: BroadcastOwnSourceForkView;
  readonly track: MediaStreamTrack;
}

const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;

function forkId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `fork_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function broadcastKind(source: LocalOriginalMediaSource): BroadcastSourceKind {
  return source;
}

@Injectable({ providedIn: "root" })
export class BroadcastOwnSourceCaptureService implements BroadcastCaptureForkPort, OnDestroy {
  readonly activeForks = signal<readonly BroadcastOwnSourceForkView[]>([]);
  private readonly forks = new Map<string, OwnedFork>();
  private readonly unregisterOriginalStop: () => void;
  private destroyed = false;

  constructor(private readonly media: MediaPublicationService) {
    this.unregisterOriginalStop = this.media.registerLocalOriginalStopListener((sourceId) => {
      void this.releaseSource(sourceId);
    });
  }

  async fork(
    _program: BroadcastProgramRef,
    source: BroadcastRoomSourceRef,
    publicationRevision: number,
    signal: AbortSignal,
  ): Promise<BroadcastCaptureForkHandle> {
    if (!source?.local) throw new BroadcastBrowserPortError("broadcast_source_not_locally_owned");
    const owned = this.media.localOriginalSources().find(({ sourceId }) => sourceId === source.sourceId);
    if (!owned || owned.kind !== (source.kind === "microphone" || source.kind === "screen-audio"
      ? "audio"
      : "video") || broadcastKind(owned.source) !== source.kind) {
      throw new BroadcastBrowserPortError("broadcast_source_not_locally_owned");
    }
    return this.createFork(source.sourceId, publicationRevision, signal);
  }

  async forkForPreview(
    sourceId: string,
    publicationRevision: number,
    signal: AbortSignal,
  ): Promise<BroadcastOwnSourceForkView> {
    if (!SOURCE_ID.test(sourceId)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_own_source_id");
    }
    return this.createFork(sourceId, publicationRevision, signal);
  }

  stream(handle: BroadcastCaptureForkHandle): MediaStream {
    const owned = this.forks.get(handle.forkId);
    if (!owned || owned.view.sourceId !== handle.sourceId || owned.view.kind !== handle.kind) {
      throw new BroadcastBrowserPortError("unknown_broadcast_capture_fork");
    }
    return owned.view.stream;
  }

  async release(handle: BroadcastCaptureForkHandle): Promise<void> {
    const owned = this.forks.get(handle.forkId);
    if (!owned) return;
    if (owned.view.sourceId !== handle.sourceId || owned.view.kind !== handle.kind) {
      throw new BroadcastBrowserPortError("invalid_broadcast_capture_fork_handle");
    }
    this.removeFork(owned);
  }

  async releaseAll(): Promise<void> {
    for (const owned of [...this.forks.values()].reverse()) this.removeFork(owned);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.unregisterOriginalStop();
    void this.releaseAll();
  }

  private createFork(
    sourceId: string,
    publicationRevision: number,
    signal: AbortSignal,
  ): BroadcastOwnSourceForkView {
    if (this.destroyed) throw new BroadcastBrowserPortError("broadcast_capture_fork_destroyed");
    signal.throwIfAborted();
    const descriptor = this.media.localOriginalSources().find((source) => source.sourceId === sourceId);
    if (!descriptor) throw new BroadcastBrowserPortError("broadcast_source_not_locally_owned");
    let track: MediaStreamTrack | null = null;
    try {
      track = this.media.cloneLocalOriginalTrack(sourceId, publicationRevision);
      const stream = new MediaStream([track]);
      const view = Object.freeze({
        forkId: forkId(),
        sourceId,
        kind: broadcastKind(descriptor.source),
        stream,
      });
      const owned: OwnedFork = { view, track };
      track.onended = () => this.removeFork(owned, false);
      this.forks.set(view.forkId, owned);
      this.publish();
      if (signal.aborted) {
        this.removeFork(owned);
        signal.throwIfAborted();
      }
      return view;
    } catch (error) {
      if (track && ![...this.forks.values()].some((owned) => owned.track === track)) {
        track.onended = null;
        if (track.readyState !== "ended") track.stop();
      }
      if (error instanceof BroadcastBrowserPortError || error instanceof DOMException) throw error;
      throw new BroadcastBrowserPortError(error instanceof Error
        ? error.message
        : "broadcast_capture_fork_failed");
    }
  }

  private async releaseSource(sourceId: string): Promise<void> {
    for (const owned of [...this.forks.values()].filter(({ view }) => view.sourceId === sourceId)) {
      this.removeFork(owned);
    }
  }

  private removeFork(owned: OwnedFork, stop = true): void {
    if (this.forks.get(owned.view.forkId) !== owned) return;
    this.forks.delete(owned.view.forkId);
    owned.track.onended = null;
    if (stop && owned.track.readyState !== "ended") owned.track.stop();
    this.publish();
  }

  private publish(): void {
    this.activeForks.set(Object.freeze([...this.forks.values()]
      .map(({ view }) => view)
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))));
  }
}
