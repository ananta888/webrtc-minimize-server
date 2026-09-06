import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";

import { BroadcastHlsPlayer, BroadcastPlayerSnapshot } from "./broadcast-hls-player";
import { MOQ_UI_CAPABILITY_STATUS } from "./moq-capability-status";
import { BroadcastViewerQualityMode } from "./broadcast-viewer-quality-policy";

@Component({
  selector: "app-broadcast-player",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./broadcast-player.component.html",
  styleUrl: "./broadcast-player.component.css",
})
export class BroadcastPlayerComponent implements OnChanges, OnDestroy {
  readonly moqCapability = MOQ_UI_CAPABILITY_STATUS;
  readonly manifestUrl = input.required<string>();
  readonly programId = input.required<string>();
  readonly playbackSessionId = input.required<string>();
  readonly suspended = input(false);
  readonly title = input("Live-Broadcast");
  readonly captionsAvailable = input(false);
  readonly closed = output<void>();
  readonly started = output<string>();
  readonly interrupted = output<string>();
  readonly video = viewChild.required<ElementRef<HTMLVideoElement>>("video");
  readonly state = signal<BroadcastPlayerSnapshot>(new BroadcastHlsPlayer().snapshot());
  readonly muted = signal(true);
  readonly volume = signal(1);
  readonly captionsVisible = signal(false);
  readonly adaptiveMode = signal<BroadcastViewerQualityMode>("auto");
  private controller: AbortController | null = null;
  private generation = 0;
  private player = this.createPlayer(0);
  private playbackIntent = false;
  private playedProgramId = "";
  private activeManifest = "";
  private activePlaybackSessionId = "";
  private interruptionReported = "";
  private preferredHeight: number | null = null;
  private preferencesApplied = -1;
  private destroyed = false;
  private readonly visibilityListener = () => {
    if (document.visibilityState === "hidden") void this.stop();
  };

  constructor() {
    document.addEventListener("visibilitychange", this.visibilityListener);
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.playbackIntent && this.playedProgramId !== this.programId()) { void this.stop(false); return; }
    if (this.suspended()) { void this.suspend(); return; }
    if (this.playbackIntent && (this.manifestUrl() !== this.activeManifest
      || this.playbackSessionId() !== this.activePlaybackSessionId)) void this.openSource();
  }

  private createPlayer(generation: number): BroadcastHlsPlayer {
    const player = new BroadcastHlsPlayer((state) => {
      if (this.destroyed || generation !== this.generation) return;
      this.state.set(state);
      if (state.qualities.length && this.preferencesApplied !== generation) {
        this.preferencesApplied = generation;
        if (this.preferredHeight !== null) {
          const sorted = [...state.qualities].sort((a, b) => a.height - b.height);
          const quality = sorted.filter(({ height }) => height <= this.preferredHeight!).at(-1) || sorted[0];
          player.selectQuality(quality.index);
        }
      }
      if (this.playbackIntent && this.interruptionReported !== this.activeManifest
        && ["ended", "failed"].includes(state.lifecycle)
        && ["broadcast_ended", "broadcast_player_media_failed", "broadcast_player_recovery_exhausted",
          "broadcast_player_manifest_unavailable", "broadcast_player_manifest_timeout"].includes(state.errorCode)) {
        const manifest = this.activeManifest;
        this.interruptionReported = manifest;
        queueMicrotask(() => {
          if (!this.destroyed && this.playbackIntent && generation === this.generation) this.interrupted.emit(manifest);
        });
      }
    });
    return player;
  }

  async start(): Promise<void> {
    if (this.destroyed || this.suspended() || this.controller || this.state().lifecycle !== "idle") return;
    this.playbackIntent = true;
    this.playedProgramId = this.programId();
    this.started.emit(this.manifestUrl());
    await this.openSource();
  }

  private async openSource(): Promise<void> {
    if (!this.playbackIntent || this.destroyed || this.suspended()) return;
    const generation = ++this.generation;
    const old = this.player;
    this.controller?.abort(new DOMException("output-generation-changed", "AbortError"));
    const controller = new AbortController();
    this.controller = controller;
    const player = this.createPlayer(generation);
    this.player = player;
    this.activeManifest = this.manifestUrl();
    this.activePlaybackSessionId = this.playbackSessionId();
    this.interruptionReported = "";
    try {
      await old.destroy();
      if (generation !== this.generation || controller.signal.aborted) return;
      player.setAdaptiveMode(this.adaptiveMode());
      await player.open(this.video().nativeElement, this.activeManifest, {
        muted: this.muted(), volume: this.volume(), captions: this.captionsAvailable(),
      }, controller.signal);
      if (generation === this.generation) player.setCaptionsVisible(this.captionsVisible());
    } catch {
      // The player exposes only its bounded public error code in state.
    }
  }

  async continuePlayback(): Promise<void> {
    try {
      await this.player.play();
    } catch {
      // The player publishes a sanitized failure state.
    }
  }

  setMuted(value: boolean): void {
    this.muted.set(value);
    this.player.setMuted(value);
  }

  setVolume(value: string): void {
    const normalized = Math.max(0, Math.min(1, Number(value)));
    this.volume.set(normalized);
    this.player.setVolume(normalized);
  }

  setQuality(value: string): void {
    this.player.selectQuality(value === "auto" ? "auto" : Number(value));
    this.preferredHeight = value === "auto" ? null : this.state().qualities.find(({ index }) => index === Number(value))?.height || null;
  }

  setAdaptiveMode(value: string): void {
    if (!new Set(["auto", "data-saver", "low", "medium", "high"]).has(value)) return;
    this.player.setAdaptiveMode(value as "auto" | "data-saver" | "low" | "medium" | "high");
    this.adaptiveMode.set(value as BroadcastViewerQualityMode);
    this.preferredHeight = null;
  }

  setCaptionsVisible(visible: boolean): void {
    this.captionsVisible.set(visible);
    this.player.setCaptionsVisible(visible);
  }

  async fullscreen(): Promise<void> {
    const element = this.video().nativeElement;
    if (element.requestFullscreen) await element.requestFullscreen();
  }

  async pictureInPicture(): Promise<void> {
    const element = this.video().nativeElement;
    if (document.pictureInPictureEnabled && element.requestPictureInPicture) {
      await element.requestPictureInPicture();
    }
  }

  async stop(emit = true): Promise<void> {
    this.playbackIntent = false;
    this.activeManifest = "";
    this.activePlaybackSessionId = "";
    const generation = this.generation + 1;
    await this.suspend();
    if (emit && !this.destroyed && generation === this.generation) this.closed.emit();
  }

  private async suspend(): Promise<void> {
    const generation = ++this.generation;
    const ended = this.state().lifecycle === "ended";
    this.controller?.abort(new DOMException("stop", "AbortError"));
    this.controller = null;
    await this.player.destroy();
    if (generation === this.generation && !this.destroyed) this.state.set(Object.freeze({
      ...new BroadcastHlsPlayer().snapshot(),
      // The old output remains ended; only fresh authorization may establish a successor.
      ...(this.suspended() ? { lifecycle: ended ? "ended" as const : "recovering" as const } : {}),
    }));
  }

  formatBitrate(value: number): string {
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(value / 1_000)} kbit/s`;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.playbackIntent = false;
    ++this.generation;
    document.removeEventListener("visibilitychange", this.visibilityListener);
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    void this.player.destroy();
  }
}
