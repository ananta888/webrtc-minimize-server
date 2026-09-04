import { Inject, Injectable, OnDestroy } from "@angular/core";

import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import {
  BroadcastBrowserPortError,
  BroadcastCaptureForkHandle,
  BroadcastCompositionHandle,
  BroadcastCompositionPort,
  BroadcastConsentDecision,
  BroadcastProgramRef,
} from "./broadcast-ports";
import {
  TRUSTED_AUDIO_PROGRAM_BUS_FACTORY,
  TrustedAudioProgramBusFactory,
  TrustedAudioProgramHandle,
  TrustedAudioProgramSettingsService,
} from "./trusted-audio-program-bus";
import { WhipMediaStreamPort, WhipResolvedMedia } from "./whip-contracts";
import {
  TRUSTED_VIDEO_COMPOSITOR_FACTORY,
  TrustedVideoCompositorFactory,
  TrustedVideoCompositorHandle,
  TrustedVideoProgramSettingsService,
} from "./trusted-video-compositor";

interface OwnedComposition {
  readonly handle: BroadcastCompositionHandle;
  readonly media: WhipResolvedMedia;
  readonly audioBus: TrustedAudioProgramHandle | null;
  readonly videoCompositor: TrustedVideoCompositorHandle | null;
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

  constructor(
    private readonly capture: BroadcastOwnSourceCaptureService,
    @Inject(TRUSTED_AUDIO_PROGRAM_BUS_FACTORY) private readonly audioBusFactory: TrustedAudioProgramBusFactory,
    private readonly audioSettings: TrustedAudioProgramSettingsService,
    @Inject(TRUSTED_VIDEO_COMPOSITOR_FACTORY) private readonly videoCompositorFactory: TrustedVideoCompositorFactory,
    private readonly videoSettings: TrustedVideoProgramSettingsService,
  ) {}

  async compose(
    _program: BroadcastProgramRef,
    forks: readonly BroadcastCaptureForkHandle[],
    consent: BroadcastConsentDecision,
    signal: AbortSignal,
  ): Promise<BroadcastCompositionHandle> {
    if (this.destroyed) throw new BroadcastBrowserPortError("broadcast_composition_destroyed");
    signal.throwIfAborted();
    if (!Array.isArray(forks) || forks.length < 1 || forks.length > 4
      || new Set(forks.map(({ forkId }) => forkId)).size !== forks.length
      || new Set(forks.map(({ sourceId }) => sourceId)).size !== forks.length
      || !consent || consent.decisionVersion !== 1
      || consent.programEpoch !== _program.programEpoch
      || !Number.isSafeInteger(consent.expiresAt) || consent.expiresAt <= Date.now()
      || !Array.isArray(consent.sourceIds) || consent.sourceIds.length !== forks.length
      || !forks.every(({ sourceId }) => consent.sourceIds.includes(sourceId))) {
      throw new BroadcastBrowserPortError("invalid_broadcast_composition_sources");
    }
    const resolved = forks.map((fork) => {
      const sourceStream = this.capture.stream(fork);
      const sourceTracks = sourceStream.getTracks();
      if (sourceTracks.length !== 1 || sourceTracks[0].readyState !== "live") {
        throw new BroadcastBrowserPortError("invalid_broadcast_composition_source");
      }
      return { fork, sourceStream, track: sourceTracks[0] };
    });
    if (resolved.some(({ track }) => track.kind !== "audio" && track.kind !== "video")) {
      throw new BroadcastBrowserPortError("broadcast_composition_required");
    }
    const audioInputs = resolved.filter(({ track }) => track.kind === "audio");
    let audioBus: TrustedAudioProgramHandle | null = null;
    let videoCompositor: TrustedVideoCompositorHandle | null = null;
    try {
    if (audioInputs.length > 0) {
      audioBus = await this.audioBusFactory.create(
        _program,
        audioInputs.map(({ fork, sourceStream }) => ({
          sourceId: fork.sourceId,
          sourceKind: fork.kind as "microphone" | "screen-audio",
          stream: sourceStream,
        })),
        this.audioSettings.profile(),
        this.audioSettings.monitoringMode(),
        signal,
      );
      signal.throwIfAborted();
    }
    const videoInputs = resolved.filter(({ track }) => track.kind === "video");
    if (videoInputs.length > 0) {
      videoCompositor = await this.videoCompositorFactory.create(
        _program,
        videoInputs.map(({ fork, sourceStream }) => ({
          sourceId: fork.sourceId,
          sourceKind: fork.kind as "camera" | "screen",
          stream: sourceStream,
        })),
        this.videoSettings.profile(),
        this.videoSettings.layout(),
        this.videoSettings.overlay(),
        signal,
      );
      signal.throwIfAborted();
    }
    const descriptors = [
      ...(videoCompositor ? [{
        sourceId: videoCompositor.outputSourceId,
        sourceKind: "program-video" as const,
        envelope: "clear-program-v1" as const,
        track: videoCompositor.track,
      }] : []),
      ...(audioBus ? [{
        sourceId: audioBus.outputSourceId,
        sourceKind: "program-audio" as const,
        envelope: "clear-program-v1" as const,
        track: audioBus.track,
        audioEncoding: Object.freeze({
          policyVersion: 1 as const,
          opusBitsPerSecond: this.audioSettings.profile().opusBitsPerSecond,
          channelCount: this.audioSettings.profile().channelCount,
          dtx: this.audioSettings.profile().dtx,
          fec: this.audioSettings.profile().fec,
          priority: "high" as const,
          contentHint: this.audioSettings.profile().priority === "screen-audio" ? "music" as const : "speech" as const,
        }),
      }] : []),
    ];
    const handle = Object.freeze({
      compositionId: compositionId(),
      sourceIds: Object.freeze(forks.map(({ sourceId }) => sourceId)),
    });
    this.compositions.set(handle.compositionId, Object.freeze({
      handle,
      audioBus,
      videoCompositor,
      media: Object.freeze({
        stream: new MediaStream(descriptors.map(({ track }) => track)),
        tracks: Object.freeze(descriptors.map((descriptor) => Object.freeze(descriptor))),
      }),
    }));
    if (signal.aborted) {
      this.compositions.delete(handle.compositionId);
      await audioBus?.close();
      await videoCompositor?.close();
      signal.throwIfAborted();
    }
    return handle;
    } catch (error) {
      await Promise.allSettled([audioBus?.close(), videoCompositor?.close()].filter(Boolean) as Promise<void>[]);
      throw error;
    }
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
    await Promise.all([owned.audioBus?.close(), owned.videoCompositor?.close()]);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const owned of this.compositions.values()) {
      void owned.audioBus?.close();
      void owned.videoCompositor?.close();
    }
    this.compositions.clear();
  }
}
