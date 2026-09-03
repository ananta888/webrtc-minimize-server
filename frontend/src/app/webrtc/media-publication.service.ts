import { Injectable, signal } from "@angular/core";

import { PeerMeshService } from "./peer-mesh.service";
import {
  AudioQualityProfile,
  MediaPrioritySource,
  MediaStrategyPreset,
  MediaStrategyService,
} from "./media-strategy.service";
import { VideoCapturePreferencesService, VideoCaptureSource } from "./video-capture-preferences.service";

interface ScreenAudioSupportedConstraints extends MediaTrackSupportedConstraints {
  readonly restrictOwnAudio?: boolean;
}

interface ScreenAudioTrackConstraints extends MediaTrackConstraints {
  readonly restrictOwnAudio?: boolean;
}

export type LocalMediaSource = "microphone" | "camera" | "screen";
export type LocalOriginalMediaSource = LocalMediaSource | "screen-audio";

export interface LocalOriginalMediaSourceView {
  readonly sourceId: string;
  readonly source: LocalOriginalMediaSource;
  readonly kind: "audio" | "video";
  readonly settings: Readonly<Pick<
    MediaTrackSettings,
    "width" | "height" | "frameRate" | "sampleRate" | "channelCount"
  >>;
}

export interface LocalMediaView {
  readonly source: LocalMediaSource;
  readonly stream: MediaStream;
  readonly kind: "audio" | "video";
}
@Injectable({ providedIn: "root" })
export class MediaPublicationService {
  readonly publications = signal<readonly LocalMediaView[]>([]);
  readonly localOriginalSources = signal<readonly LocalOriginalMediaSourceView[]>([]);
  readonly localPublicationRevision = signal(1);
  readonly error = signal("");
  readonly pending = signal<LocalMediaSource | null>(null);
  readonly screenAudioActive = signal(false);
  private readonly streams = new Map<LocalMediaSource, MediaStream>();
  private readonly microphoneStopListeners = new Set<() => void>();
  private readonly screenAudioStopListeners = new Set<() => void>();
  private readonly localOriginalStopListeners = new Set<(sourceId: string) => void>();
  private readonly localOriginalTracks = new Map<string, {
    readonly source: LocalOriginalMediaSource;
    readonly track: MediaStreamTrack;
  }>();
  private readonly localOriginalIds = new Map<MediaStreamTrack, string>();
  private readonly constraintUpdates: Record<VideoCaptureSource, Promise<void>> = {
    camera: Promise.resolve(),
    screen: Promise.resolve(),
  };
  private audioConstraintUpdate = Promise.resolve();

  constructor(
    private readonly mesh: PeerMeshService,
    private readonly videoPreferences: VideoCapturePreferencesService,
    private readonly mediaStrategy: MediaStrategyService,
  ) {}

  async toggle(source: LocalMediaSource): Promise<void> {
    if (this.streams.has(source)) {
      this.stop(source);
      return;
    }
    await this.start(source);
  }

  async start(source: LocalMediaSource): Promise<void> {
    if (this.pending() || this.streams.has(source)) return;
    this.pending.set(source);
    this.error.set("");
    let stream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices) throw new Error("media_devices_unavailable");
      if (source === "microphone") {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: this.mediaStrategy.audioConstraints(),
          video: false,
        });
      } else if (source === "camera") {
        stream = await navigator.mediaDevices.getUserMedia({
          video: this.videoPreferences.constraints("camera"),
          audio: false,
        });
      } else {
        if (!navigator.mediaDevices.getDisplayMedia) throw new Error("display_capture_unavailable");
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: this.videoPreferences.constraints("screen"),
          audio: this.videoPreferences.screenAudioEnabled() ? this.screenAudioConstraints() : false,
        });
      }
      if (source !== "microphone" && stream.getVideoTracks().length === 0) throw new Error("video_track_missing");
      if (source === "microphone" && stream.getAudioTracks().length === 0) throw new Error("audio_track_missing");
      if (source === "screen" && !this.videoPreferences.screenAudioEnabled()) {
        for (const track of stream.getAudioTracks()) {
          track.stop();
          stream.removeTrack(track);
        }
      }
      if (source === "microphone") this.mediaStrategy.recordAppliedAudio(stream.getAudioTracks()[0].getSettings());
      else this.recordAppliedSettings(source, stream.getVideoTracks()[0]);
      if (source === "screen") this.screenAudioActive.set(stream.getAudioTracks().length > 0);
      this.streams.set(source, stream);
      this.registerLocalOriginalTracks(source, stream.getTracks());
      this.mesh.attachPublication(source, stream);
      const view: LocalMediaView = {
        source,
        stream,
        kind: stream.getVideoTracks().length ? "video" : "audio",
      };
      this.publications.update((items) => [...items.filter((item) => item.source !== source), view]);
      for (const track of stream.getTracks()) {
        track.onended = source === "screen" && track.kind === "audio"
          ? () => this.removeScreenAudioTrack(track)
          : () => this.stop(source);
      }
    } catch (error) {
      if (stream) {
        try { this.mesh.detachPublication(source); } catch { /* best-effort partial attach cleanup */ }
        this.streams.delete(source);
        this.unregisterLocalOriginalTracks(stream.getTracks());
      }
      for (const track of stream?.getTracks() || []) {
        track.onended = null;
        track.stop();
      }
      if (source === "screen") this.screenAudioActive.set(false);
      const name = error instanceof DOMException ? error.name : "";
      this.error.set(name === "NotAllowedError" ? "media_permission_denied" : error instanceof Error ? error.message : "media_capture_failed");
    } finally {
      this.pending.set(null);
    }
  }

  stop(source: LocalMediaSource): void {
    const stream = this.streams.get(source);
    if (!stream) {
      if (source === "screen") this.screenAudioActive.set(false);
      return;
    }
    if (source === "microphone") {
      this.notifyStopListeners(this.microphoneStopListeners);
    } else if (source === "screen" && stream.getAudioTracks().length > 0) {
      this.notifyStopListeners(this.screenAudioStopListeners);
    }
    this.mesh.detachPublication(source);
    this.unregisterLocalOriginalTracks(stream.getTracks());
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    this.streams.delete(source);
    this.publications.update((items) => items.filter((item) => item.source !== source));
    if (source === "microphone") this.mediaStrategy.clearAppliedAudio();
    else this.videoPreferences.clearApplied(source);
    if (source === "screen") this.screenAudioActive.set(false);
  }

  stopAll(): void {
    for (const source of [...this.streams.keys()]) this.stop(source);
  }

  active(source: LocalMediaSource): boolean {
    return this.streams.has(source);
  }

  microphoneTrack(): MediaStreamTrack | null {
    return this.streams.get("microphone")?.getAudioTracks()[0] || null;
  }

  screenAudioTrack(): MediaStreamTrack | null {
    return this.streams.get("screen")?.getAudioTracks()[0] || null;
  }

  registerMicrophoneStopListener(listener: () => void): () => void {
    this.microphoneStopListeners.add(listener);
    return () => this.microphoneStopListeners.delete(listener);
  }

  registerScreenAudioStopListener(listener: () => void): () => void {
    this.screenAudioStopListeners.add(listener);
    return () => this.screenAudioStopListeners.delete(listener);
  }

  registerLocalOriginalStopListener(listener: (sourceId: string) => void): () => void {
    this.localOriginalStopListeners.add(listener);
    return () => this.localOriginalStopListeners.delete(listener);
  }

  cloneLocalOriginalTrack(sourceId: string, publicationRevision: number): MediaStreamTrack {
    if (!Number.isSafeInteger(publicationRevision)
      || publicationRevision !== this.localPublicationRevision()) {
      throw new Error("stale_local_publication_revision");
    }
    const owned = this.localOriginalTracks.get(sourceId);
    if (!owned || owned.track.readyState === "ended" || typeof owned.track.clone !== "function") {
      throw new Error("local_original_source_unavailable");
    }
    const clone = owned.track.clone();
    if (!clone || clone === owned.track || clone.kind !== owned.track.kind) {
      try { clone?.stop(); } catch { /* invalid clone has no usable lifecycle */ }
      throw new Error("invalid_local_original_clone");
    }
    return clone;
  }

  async setVideoResolution(source: VideoCaptureSource, resolutionId: unknown): Promise<void> {
    this.videoPreferences.setResolution(source, resolutionId);
    await this.applyVideoPreferences(source);
  }

  async setVideoFrameRate(source: VideoCaptureSource, frameRate: unknown): Promise<void> {
    this.videoPreferences.setFrameRate(source, frameRate);
    await this.applyVideoPreferences(source);
  }

  setScreenAudioEnabled(enabled: unknown): void {
    this.videoPreferences.setScreenAudioEnabled(enabled);
    if (enabled !== true) this.stopScreenAudio();
  }

  async setMediaStrategyPreset(preset: MediaStrategyPreset | unknown): Promise<void> {
    this.mediaStrategy.selectPreset(preset);
    await this.applyAudioPreferences();
    this.mesh.refreshMediaStrategy();
  }

  async setAudioQualityProfile(profile: AudioQualityProfile | unknown): Promise<void> {
    this.mediaStrategy.setAudioProfile(profile);
    await this.applyAudioPreferences();
    this.mesh.refreshMediaStrategy();
  }

  setMediaPriorityAt(index: number, source: MediaPrioritySource | unknown): void {
    this.mediaStrategy.setPriorityAt(index, source);
    this.mesh.refreshMediaStrategy();
  }

  setOptimizationMode(mode: unknown): void {
    this.mediaStrategy.setOptimizationMode(mode);
    this.mesh.refreshMediaStrategy();
  }

  private async applyAudioPreferences(): Promise<void> {
    const update = this.audioConstraintUpdate.then(() => this.applyCurrentAudioPreferences());
    this.audioConstraintUpdate = update;
    await update;
  }

  private async applyCurrentAudioPreferences(): Promise<void> {
    const track = this.streams.get("microphone")?.getAudioTracks()[0];
    if (!track) return;
    this.error.set("");
    try {
      await track.applyConstraints(this.mediaStrategy.audioConstraints());
      this.mediaStrategy.recordAppliedAudio(track.getSettings());
    } catch (error) {
      this.mediaStrategy.recordAppliedAudio(track.getSettings());
      const name = error instanceof DOMException ? error.name : "";
      this.error.set(name === "OverconstrainedError"
        ? "audio_constraints_unsupported"
        : error instanceof Error ? error.message : "audio_constraints_failed");
    } finally {
      this.refreshLocalOriginalSources();
    }
  }

  private async applyVideoPreferences(source: VideoCaptureSource): Promise<void> {
    const update = this.constraintUpdates[source].then(() => this.applyCurrentVideoPreferences(source));
    this.constraintUpdates[source] = update;
    await update;
  }

  private async applyCurrentVideoPreferences(source: VideoCaptureSource): Promise<void> {
    const track = this.streams.get(source)?.getVideoTracks()[0];
    if (!track) return;
    this.error.set("");
    try {
      await track.applyConstraints(this.videoPreferences.constraints(source));
      this.recordAppliedSettings(source, track);
    } catch (error) {
      this.recordAppliedSettings(source, track);
      const name = error instanceof DOMException ? error.name : "";
      this.error.set(name === "OverconstrainedError"
        ? "video_constraints_unsupported"
        : error instanceof Error ? error.message : "video_constraints_failed");
    } finally {
      this.refreshLocalOriginalSources();
    }
  }

  private recordAppliedSettings(source: VideoCaptureSource, track: MediaStreamTrack): void {
    this.videoPreferences.recordApplied(source, track.getSettings());
  }

  private screenAudioConstraints(): true | ScreenAudioTrackConstraints {
    try {
      const supported = typeof navigator.mediaDevices.getSupportedConstraints === "function"
        ? navigator.mediaDevices.getSupportedConstraints() as ScreenAudioSupportedConstraints
        : null;
      if (supported?.restrictOwnAudio) return { restrictOwnAudio: true };
    } catch {
      // A boolean audio request is the portable fallback; the explicit opt-in and warning still apply.
    }
    return true;
  }

  private stopScreenAudio(): void {
    const stream = this.streams.get("screen");
    if (!stream) {
      this.screenAudioActive.set(false);
      return;
    }
    for (const track of [...stream.getAudioTracks()]) this.removeScreenAudioTrack(track);
  }

  private removeScreenAudioTrack(track: MediaStreamTrack): void {
    const stream = this.streams.get("screen");
    if (!stream || !stream.getTracks().includes(track)) return;
    track.onended = null;
    this.notifyStopListeners(this.screenAudioStopListeners);
    this.mesh.detachPublicationTrack("screen", track);
    this.unregisterLocalOriginalTracks([track]);
    if (track.readyState !== "ended") track.stop();
    this.screenAudioActive.set(stream.getAudioTracks().length > 0);
  }

  private notifyStopListeners(listeners: ReadonlySet<() => void>): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* a consumer cannot block capture shutdown */ }
    }
  }

  private registerLocalOriginalTracks(source: LocalMediaSource, tracks: readonly MediaStreamTrack[]): void {
    let changed = false;
    for (const track of tracks) {
      if (this.localOriginalIds.has(track)) continue;
      const trackSource: LocalOriginalMediaSource = source === "screen" && track.kind === "audio"
        ? "screen-audio"
        : source;
      const sourceId = this.localSourceId();
      this.localOriginalIds.set(track, sourceId);
      this.localOriginalTracks.set(sourceId, { source: trackSource, track });
      changed = true;
    }
    if (changed) this.bumpLocalPublicationRevision();
  }

  private unregisterLocalOriginalTracks(tracks: readonly MediaStreamTrack[]): void {
    const removed: string[] = [];
    for (const track of tracks) {
      const sourceId = this.localOriginalIds.get(track);
      if (!sourceId) continue;
      this.localOriginalIds.delete(track);
      this.localOriginalTracks.delete(sourceId);
      removed.push(sourceId);
    }
    if (removed.length === 0) return;
    this.bumpLocalPublicationRevision();
    for (const sourceId of removed) {
      for (const listener of this.localOriginalStopListeners) {
        try { listener(sourceId); } catch { /* a consumer cannot block original capture shutdown */ }
      }
    }
  }

  private bumpLocalPublicationRevision(): void {
    const next = this.localPublicationRevision() >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.localPublicationRevision() + 1;
    this.localPublicationRevision.set(next);
    this.refreshLocalOriginalSources();
  }

  private refreshLocalOriginalSources(): void {
    this.localOriginalSources.set(Object.freeze([...this.localOriginalTracks.entries()]
      .map(([sourceId, { source, track }]) => {
        const settings = track.getSettings();
        return Object.freeze({
          sourceId,
          source,
          kind: track.kind as "audio" | "video",
          settings: Object.freeze({
            width: settings.width,
            height: settings.height,
            frameRate: settings.frameRate,
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
          }),
        });
      })
      .sort((left, right) => left.source.localeCompare(right.source))));
  }

  private localSourceId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `src_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
}
