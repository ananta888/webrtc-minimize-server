import { Inject, Injectable, OnDestroy } from "@angular/core";

import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import { BroadcastCompositionLifetime } from "./broadcast-composition-lifetime";
import { BroadcastCaptionStyle } from "./broadcast-caption-packager";
import { BroadcastVideoDirectionPort, BroadcastVideoDirectionRequest, BroadcastVideoDirectionView, validateVideoDirectionRequest } from "./broadcast-video-direction";
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
  readonly lifetime: BroadcastCompositionLifetime;
  readonly direction: {
    revision: number;
    activeSourceId: string;
    readonly inputs: readonly { readonly sourceId: string; readonly kind: "camera" | "screen"; readonly track: MediaStreamTrack }[];
  };
}

function compositionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `composition_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

@Injectable({ providedIn: "root" })
export class BroadcastOwnSourceCompositionService
implements BroadcastCompositionPort, BroadcastVideoDirectionPort, WhipMediaStreamPort, OnDestroy {
  private readonly compositions = new Map<string, OwnedComposition>();
  private readonly lifetimes = new Set<BroadcastCompositionLifetime>();
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
    const authorizedExpiresAt = consent.expiresAt;
    const sourceIds = Object.freeze(forks.map(({ sourceId }) => sourceId));
    const resolved = forks.map((value) => {
      const fork = Object.freeze({ forkId: value.forkId, sourceId: value.sourceId, kind: value.kind });
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
    let ownedId = "";
    const lifetime = new BroadcastCompositionLifetime(signal, () => {}, () => {
      this.lifetimes.delete(lifetime);
      if (ownedId) this.compositions.delete(ownedId);
    });
    this.lifetimes.add(lifetime);
    try {
    if (audioInputs.length > 0) {
      audioBus = await lifetime.acquire(setupSignal => this.audioBusFactory.create(
        _program,
        audioInputs.map(({ fork, sourceStream }) => ({
          sourceId: fork.sourceId,
          sourceKind: fork.kind as "microphone" | "screen-audio",
          stream: sourceStream,
        })),
        this.audioSettings.profile(),
        this.audioSettings.monitoringMode(),
        setupSignal,
      ));
      lifetime.signal.throwIfAborted();
    }
    const videoInputs = resolved.filter(({ track }) => track.kind === "video");
    if (videoInputs.length > 0) {
      videoCompositor = await lifetime.acquire(setupSignal => this.videoCompositorFactory.create(
        _program,
        videoInputs.map(({ fork, sourceStream }) => ({
          sourceId: fork.sourceId,
          sourceKind: fork.kind as "camera" | "screen",
          stream: sourceStream,
        })),
        this.videoSettings.profile(),
        this.videoSettings.layout(),
        this.videoSettings.overlay(),
        setupSignal,
      ));
      lifetime.signal.throwIfAborted();
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
      sourceIds,
    });
    if (this.destroyed || authorizedExpiresAt <= Date.now()) throw new BroadcastBrowserPortError("broadcast_composition_authority_expired");
    ownedId = handle.compositionId;
    this.compositions.set(handle.compositionId, Object.freeze({
      handle,
      audioBus,
      videoCompositor,
      lifetime,
      direction: { revision: 1, activeSourceId: "", inputs: Object.freeze(videoInputs.map(({ fork, track }) => Object.freeze({
        sourceId: fork.sourceId, kind: fork.kind as "camera" | "screen", track,
      }))) },
      media: Object.freeze({
        stream: new MediaStream(descriptors.map(({ track }) => track)),
        tracks: Object.freeze(descriptors.map((descriptor) => Object.freeze(descriptor))),
      }),
    }));
    lifetime.signal.throwIfAborted();
    return handle;
    } catch (error) {
      await lifetime.close().catch(() => {});
      throw error;
    }
  }

  async resolve(composition: BroadcastCompositionHandle, signal: AbortSignal): Promise<WhipResolvedMedia> {
    signal.throwIfAborted();
    const owned = this.compositions.get(composition.compositionId);
    if (!owned || owned.lifetime.signal.aborted || owned.handle.sourceIds.length !== composition.sourceIds.length
      || !owned.handle.sourceIds.every((sourceId, index) => sourceId === composition.sourceIds[index])) {
      throw new BroadcastBrowserPortError("unknown_broadcast_composition");
    }
    return owned.media;
  }

  setCaptionOverlay(
    composition: BroadcastCompositionHandle,
    text: string,
    style: BroadcastCaptionStyle,
    positionPercent: number,
  ): boolean {
    const owned = this.compositions.get(composition.compositionId);
    if (!owned || owned.lifetime.signal.aborted || !owned.videoCompositor || typeof text !== "string" || text.length > 240
      || owned.handle.sourceIds.length !== composition.sourceIds.length
      || !owned.handle.sourceIds.every((sourceId, index) => sourceId === composition.sourceIds[index])) return false;
    owned.videoCompositor.setOverlay({
      ...this.videoSettings.overlay(),
      showCaptions: text.length > 0,
      captionText: text,
      captionStyle: style,
      captionPositionPercent: positionPercent,
    });
    return true;
  }

  async release(handle: BroadcastCompositionHandle): Promise<void> {
    const owned = this.compositions.get(handle.compositionId);
    if (!owned) return;
    if (owned.handle.sourceIds.length !== handle.sourceIds.length
      || !owned.handle.sourceIds.every((sourceId, index) => sourceId === handle.sourceIds[index])) {
      throw new BroadcastBrowserPortError("invalid_broadcast_composition_handle");
    }
    await owned.lifetime.close();
  }

  videoDirection(handle: BroadcastCompositionHandle): BroadcastVideoDirectionView | null {
    const owned = this.compositions.get(handle?.compositionId);
    if (!owned || owned.lifetime.signal.aborted || !owned.videoCompositor
      || owned.videoCompositor.track.readyState !== "live" || !Array.isArray(handle.sourceIds)
      || owned.handle.sourceIds.length !== handle.sourceIds.length
      || !owned.handle.sourceIds.every((id, index) => id === handle.sourceIds[index])) return null;
    const sources = owned.direction.inputs.filter(({ track }) => track.readyState === "live")
      .map(({ sourceId, kind }) => Object.freeze({ sourceId, kind }));
    return Object.freeze({ version: 1, compositionId: owned.handle.compositionId,
      revision: owned.direction.revision, layout: owned.videoCompositor.snapshot().layout,
      activeSourceId: sources.some(({ sourceId }) => sourceId === owned.direction.activeSourceId) ? owned.direction.activeSourceId : "",
      sources: Object.freeze(sources) });
  }

  directVideo(handle: BroadcastCompositionHandle, request: BroadcastVideoDirectionRequest): BroadcastVideoDirectionView {
    validateVideoDirectionRequest(request);
    const current = this.videoDirection(handle);
    if (!current || request.compositionId !== current.compositionId) throw new BroadcastBrowserPortError("broadcast_video_direction_unavailable");
    if (request.expectedRevision !== current.revision || current.revision === Number.MAX_SAFE_INTEGER) {
      throw new BroadcastBrowserPortError("stale_broadcast_video_direction");
    }
    if (request.activeSourceId && !current.sources.some(({ sourceId }) => sourceId === request.activeSourceId)) {
      throw new BroadcastBrowserPortError("broadcast_video_source_unavailable");
    }
    const owned = this.compositions.get(current.compositionId)!;
    owned.videoCompositor!.setLayout(request.layout, request.activeSourceId || current.sources[0]?.sourceId || "");
    owned.direction.activeSourceId = request.activeSourceId;
    owned.direction.revision++;
    return this.videoDirection(handle)!;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const lifetime of this.lifetimes) void lifetime.close().catch(() => {});
  }
}
