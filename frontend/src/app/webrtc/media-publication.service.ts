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

export interface LocalMediaView {
  readonly source: LocalMediaSource;
  readonly stream: MediaStream;
  readonly kind: "audio" | "video";
}
@Injectable({ providedIn: "root" })
export class MediaPublicationService {
  readonly publications = signal<readonly LocalMediaView[]>([]);
  readonly error = signal("");
  readonly pending = signal<LocalMediaSource | null>(null);
  readonly screenAudioActive = signal(false);
  private readonly streams = new Map<LocalMediaSource, MediaStream>();
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
      for (const track of stream?.getTracks() || []) track.stop();
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
    this.mesh.detachPublication(source);
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
    this.mesh.detachPublicationTrack("screen", track);
    if (track.readyState !== "ended") track.stop();
    this.screenAudioActive.set(stream.getAudioTracks().length > 0);
  }
}
