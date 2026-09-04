import { Injectable, OnDestroy } from "@angular/core";

import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import {
  BroadcastBrowserPortError,
  BroadcastCaptureForkHandle,
  BroadcastCompositionHandle,
  BroadcastCompositionPort,
  BroadcastProgramRef,
} from "./broadcast-ports";
import { WhipMediaStreamPort, WhipResolvedMedia } from "./whip-contracts";

interface OwnedComposition {
  readonly handle: BroadcastCompositionHandle;
  readonly media: WhipResolvedMedia;
}

function compositionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `composition_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

@Injectable({ providedIn: "root" })
export class BroadcastOwnSourceCompositionService
implements BroadcastCompositionPort, WhipMediaStreamPort, OnDestroy {
  private readonly compositions = new Map<string, OwnedComposition>();
  private destroyed = false;

  constructor(private readonly capture: BroadcastOwnSourceCaptureService) {}

  async compose(
    _program: BroadcastProgramRef,
    forks: readonly BroadcastCaptureForkHandle[],
    signal: AbortSignal,
  ): Promise<BroadcastCompositionHandle> {
    if (this.destroyed) throw new BroadcastBrowserPortError("broadcast_composition_destroyed");
    signal.throwIfAborted();
    if (!Array.isArray(forks) || forks.length < 1 || forks.length > 2
      || new Set(forks.map(({ forkId }) => forkId)).size !== forks.length
      || new Set(forks.map(({ sourceId }) => sourceId)).size !== forks.length) {
      throw new BroadcastBrowserPortError("invalid_broadcast_composition_sources");
    }
    const tracks = forks.map((fork) => {
      const sourceStream = this.capture.stream(fork);
      const sourceTracks = sourceStream.getTracks();
      if (sourceTracks.length !== 1 || sourceTracks[0].readyState !== "live") {
        throw new BroadcastBrowserPortError("invalid_broadcast_composition_source");
      }
      return sourceTracks[0];
    });
    if (tracks.filter(({ kind }) => kind === "audio").length > 1
      || tracks.filter(({ kind }) => kind === "video").length > 1
      || tracks.some(({ kind }) => kind !== "audio" && kind !== "video")) {
      throw new BroadcastBrowserPortError("broadcast_composition_required");
    }
    const handle = Object.freeze({
      compositionId: compositionId(),
      sourceIds: Object.freeze(forks.map(({ sourceId }) => sourceId)),
    });
    this.compositions.set(handle.compositionId, Object.freeze({
      handle,
      media: Object.freeze({
        stream: new MediaStream(tracks),
        tracks: Object.freeze(forks.map((fork, index) => Object.freeze({
          sourceId: fork.sourceId,
          sourceKind: fork.kind,
          envelope: "clear-program-v1" as const,
          track: tracks[index],
        }))),
      }),
    }));
    if (signal.aborted) {
      this.compositions.delete(handle.compositionId);
      signal.throwIfAborted();
    }
    return handle;
  }

  async resolve(composition: BroadcastCompositionHandle, signal: AbortSignal): Promise<WhipResolvedMedia> {
    signal.throwIfAborted();
    const owned = this.compositions.get(composition.compositionId);
    if (!owned || owned.handle.sourceIds.length !== composition.sourceIds.length
      || !owned.handle.sourceIds.every((sourceId, index) => sourceId === composition.sourceIds[index])) {
      throw new BroadcastBrowserPortError("unknown_broadcast_composition");
    }
    return owned.media;
  }

  async release(handle: BroadcastCompositionHandle): Promise<void> {
    const owned = this.compositions.get(handle.compositionId);
    if (!owned) return;
    if (owned.handle.sourceIds.length !== handle.sourceIds.length
      || !owned.handle.sourceIds.every((sourceId, index) => sourceId === handle.sourceIds[index])) {
      throw new BroadcastBrowserPortError("invalid_broadcast_composition_handle");
    }
    this.compositions.delete(handle.compositionId);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.compositions.clear();
  }
}
