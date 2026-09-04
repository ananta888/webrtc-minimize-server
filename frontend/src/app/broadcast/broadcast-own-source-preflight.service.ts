import { Inject, Injectable, OnDestroy, Signal, computed, signal } from "@angular/core";

import {
  LocalOriginalMediaSource,
  LocalOriginalMediaSourceView,
  MediaPublicationService,
} from "../webrtc/media-publication.service";
import {
  BROADCAST_AUDIO_METER_FACTORY,
  BroadcastAudioMeter,
  BroadcastAudioMeterFactory,
} from "./broadcast-audio-meter";
import {
  BroadcastOwnSourceCaptureService,
  BroadcastOwnSourceForkView,
} from "./broadcast-own-source-capture.service";
import { BroadcastBrowserPortError } from "./broadcast-ports";
import {
  TRUSTED_AUDIO_PROGRAM_BUS_FACTORY,
  TrustedAudioProgramBusFactory,
  TrustedAudioProgramHandle,
  TrustedAudioProgramSettingsService,
  TrustedAudioProgramSnapshot,
} from "./trusted-audio-program-bus";

export type BroadcastPreflightAudience = "private" | "unlisted" | "public";
export type BroadcastPreflightLifecycle = "idle" | "preparing" | "ready" | "stopping" | "failed";

export interface BroadcastPreviewView extends BroadcastOwnSourceForkView {
  readonly source: LocalOriginalMediaSource;
  readonly label: string;
}

const SOURCE_LABELS: Readonly<Record<LocalOriginalMediaSource, string>> = Object.freeze({
  microphone: "Mikrofon",
  camera: "Kamera",
  screen: "Bildschirm",
  "screen-audio": "Bildschirmton",
});

function videoEstimate(source: LocalOriginalMediaSourceView): number {
  const width = Math.min(3840, Math.max(160, source.settings.width || 1280));
  const height = Math.min(2160, Math.max(90, source.settings.height || 720));
  const fps = Math.min(60, Math.max(1, source.settings.frameRate || (source.source === "screen" ? 15 : 24)));
  const factor = source.source === "screen" ? 0.12 : 0.075;
  return Math.min(8_000_000, Math.max(180_000, Math.round(width * height * fps * factor)));
}

@Injectable({ providedIn: "root" })
export class BroadcastOwnSourcePreflightService implements OnDestroy {
  readonly selectedSourceIds = signal<readonly string[]>([]);
  readonly audience = signal<BroadcastPreflightAudience>("private");
  readonly includeCaptions = signal(false);
  readonly lifecycle = signal<BroadcastPreflightLifecycle>("idle");
  readonly previews = signal<readonly BroadcastPreviewView[]>([]);
  readonly audioLevels = signal<Readonly<Record<string, number>>>({});
  readonly programAudio = signal<TrustedAudioProgramSnapshot | null>(null);
  readonly errorCode = signal("");
  readonly panelVisible = signal(false);
  readonly sources: Signal<readonly LocalOriginalMediaSourceView[]>;
  readonly selectedSources: Signal<readonly LocalOriginalMediaSourceView[]>;
  readonly estimatedUploadBitsPerSecond: Signal<number>;
  readonly codecProfile: Signal<string>;
  private readonly meters = new Map<string, BroadcastAudioMeter>();
  private readonly unregisterOriginalStop: () => void;
  private controller: AbortController | null = null;
  private prepareTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private programAudioHandle: TrustedAudioProgramHandle | null = null;
  private programAudioTimer = 0;
  private destroyed = false;

  constructor(
    private readonly media: MediaPublicationService,
    private readonly capture: BroadcastOwnSourceCaptureService,
    @Inject(BROADCAST_AUDIO_METER_FACTORY) private readonly meterFactory: BroadcastAudioMeterFactory,
    @Inject(TRUSTED_AUDIO_PROGRAM_BUS_FACTORY) private readonly programAudioFactory: TrustedAudioProgramBusFactory,
    private readonly audioSettings: TrustedAudioProgramSettingsService,
  ) {
    this.sources = this.media.localOriginalSources;
    this.selectedSources = computed(() => {
      const selected = new Set(this.selectedSourceIds());
      return this.sources().filter(({ sourceId }) => selected.has(sourceId));
    });
    this.estimatedUploadBitsPerSecond = computed(() => this.selectedSources().reduce((total, source) => (
      total + (source.kind === "video"
        ? videoEstimate(source)
        : source.source === "screen-audio" ? 96_000 : 64_000)
    ), 0));
    this.codecProfile = computed(() => {
      const kinds = new Set(this.selectedSources().map(({ kind }) => kind));
      if (kinds.has("video") && kinds.has("audio")) return "Browser-Video + Opus; WHIP-/Ausgabe-Codec noch nicht ausgehandelt";
      if (kinds.has("video")) return "Browser-Video; WHIP-/Ausgabe-Codec noch nicht ausgehandelt";
      if (kinds.has("audio")) return "Opus-Vorschau; Ausgabe-Codec noch nicht ausgehandelt";
      return "Noch keine Quelle gewählt";
    });
    this.unregisterOriginalStop = this.media.registerLocalOriginalStopListener((sourceId) => {
      this.selectedSourceIds.update((ids) => ids.filter((id) => id !== sourceId));
      if (this.previews().some((preview) => preview.sourceId === sourceId)) {
        void this.stopPreview("source-ended");
      }
    });
  }

  setPanelVisible(visible: boolean): void {
    this.panelVisible.set(visible);
  }

  setSourceSelected(sourceId: string, selected: boolean): boolean {
    if (this.lifecycle() === "preparing" || this.lifecycle() === "stopping") return false;
    const source = this.sources().find((candidate) => candidate.sourceId === sourceId);
    if (!source) return false;
    const next = new Set(this.selectedSourceIds());
    if (selected) next.add(sourceId);
    else next.delete(sourceId);
    this.selectedSourceIds.set(Object.freeze([...next].slice(0, 4)));
    if (this.lifecycle() === "ready") void this.stopPreview("selection-changed");
    return true;
  }

  setAudience(value: unknown): boolean {
    if (value !== "private" && value !== "unlisted" && value !== "public") return false;
    this.audience.set(value);
    return true;
  }

  setIncludeCaptions(value: unknown): void {
    this.includeCaptions.set(value === true);
  }

  async preparePreview(trigger: unknown): Promise<void> {
    if (trigger !== "user-action") {
      throw new BroadcastBrowserPortError("explicit_broadcast_preview_required");
    }
    if (this.destroyed) throw new BroadcastBrowserPortError("broadcast_preflight_destroyed");
    if (this.prepareTask || this.stopTask) throw new BroadcastBrowserPortError("broadcast_preflight_busy");
    await this.stopPreview("replace-preview");
    const sourceIds = [...this.selectedSourceIds()];
    if (sourceIds.length < 1 || sourceIds.length > 4) {
      throw new BroadcastBrowserPortError("broadcast_preview_source_required");
    }
    const revision = this.media.localPublicationRevision();
    if (sourceIds.some((id) => !this.sources().some(({ sourceId }) => sourceId === id))) {
      throw new BroadcastBrowserPortError("broadcast_preview_source_unavailable");
    }
    this.lifecycle.set("preparing");
    this.errorCode.set("");
    this.controller = new AbortController();
    const task = this.runPrepare(sourceIds, revision, this.controller.signal);
    this.prepareTask = task;
    try {
      await task;
    } finally {
      if (this.prepareTask === task) this.prepareTask = null;
    }
  }

  async stopPreview(reason = "user-stop"): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.runStop(reason);
    this.stopTask = task;
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = null;
    }
  }

  async resetForSession(): Promise<void> {
    await this.stopPreview("session-reset");
    this.selectedSourceIds.set(Object.freeze([]));
    this.includeCaptions.set(false);
    this.panelVisible.set(false);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    try {
      await this.resetForSession();
    } finally {
      this.unregisterOriginalStop();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    this.unregisterOriginalStop();
    void this.stopPreview("destroy");
  }

  sourceLabel(source: LocalOriginalMediaSource): string {
    return SOURCE_LABELS[source];
  }

  formatBitrate(bitsPerSecond: number): string {
    if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbit/s`;
    return `${Math.round(bitsPerSecond / 1_000)} kbit/s`;
  }

  private async runPrepare(
    sourceIds: readonly string[],
    revision: number,
    signal: AbortSignal,
  ): Promise<void> {
    const previews: BroadcastPreviewView[] = [];
    try {
      for (const sourceId of sourceIds) {
        const descriptor = this.sources().find((source) => source.sourceId === sourceId);
        if (!descriptor) throw new BroadcastBrowserPortError("broadcast_preview_source_unavailable");
        const fork = await this.capture.forkForPreview(sourceId, revision, signal);
        previews.push(Object.freeze({
          ...fork,
          source: descriptor.source,
          label: SOURCE_LABELS[descriptor.source],
        }));
        this.previews.set(Object.freeze([...previews]));
        signal.throwIfAborted();
        if (descriptor.kind === "audio" && this.meterFactory.supported) {
          const meter = await this.meterFactory.create(fork.stream, (level) => {
            if (!Number.isFinite(level)) return;
            this.audioLevels.update((levels) => Object.freeze({
              ...levels,
              [fork.forkId]: Math.min(1, Math.max(0, level)),
            }));
          });
          this.meters.set(fork.forkId, meter);
          signal.throwIfAborted();
        }
      }
      const audioPreviews = previews.filter(({ kind }) => kind === "microphone" || kind === "screen-audio");
      if (audioPreviews.length > 0 && this.programAudioFactory.supported) {
        this.programAudioHandle = await this.programAudioFactory.create({
          tenantId: "tn_localpreview0000",
          roomId: "room-local-preview",
          programId: "prg_localpreview000",
          programRevision: revision,
          programEpoch: Math.max(1, revision),
        }, audioPreviews.map(({ sourceId, kind, stream }) => ({
          sourceId,
          sourceKind: kind as "microphone" | "screen-audio",
          stream,
        })), this.audioSettings.profile(), this.audioSettings.monitoringMode(), signal);
        this.programAudio.set(this.programAudioHandle.snapshot());
        this.programAudioTimer = window.setInterval(() => {
          if (this.programAudioHandle) this.programAudio.set(this.programAudioHandle.snapshot());
        }, 100);
        signal.throwIfAborted();
      }
      this.previews.set(Object.freeze(previews));
      this.lifecycle.set("ready");
    } catch (error) {
      let cleanupFailed = false;
      try {
        await this.cleanup(previews);
        this.previews.set(Object.freeze([]));
      } catch {
        cleanupFailed = true;
      }
      this.lifecycle.set(signal.aborted && !cleanupFailed ? "idle" : "failed");
      if (!signal.aborted || cleanupFailed) {
        this.errorCode.set(error instanceof Error ? error.message : "broadcast_preview_failed");
      }
      throw error;
    } finally {
      if (this.controller?.signal === signal) this.controller = null;
    }
  }

  private async runStop(reason: string): Promise<void> {
    this.controller?.abort(new DOMException(reason, "AbortError"));
    if (this.prepareTask) {
      try { await this.prepareTask; } catch { /* runPrepare owns partial cleanup */ }
    }
    const previews = [...this.previews()];
    this.lifecycle.set(previews.length > 0 ? "stopping" : "idle");
    try {
      await this.cleanup(previews);
      this.previews.set(Object.freeze([]));
      this.audioLevels.set(Object.freeze({}));
      this.lifecycle.set("idle");
      this.errorCode.set("");
    } catch (error) {
      this.lifecycle.set("failed");
      this.errorCode.set(error instanceof Error && error.message
        ? error.message
        : "broadcast_preview_cleanup_failed");
      throw error;
    }
  }

  private async cleanup(previews: readonly BroadcastPreviewView[]): Promise<void> {
    const errors: unknown[] = [];
    window.clearInterval(this.programAudioTimer);
    this.programAudioTimer = 0;
    if (this.programAudioHandle) {
      try {
        await this.programAudioHandle.close();
        this.programAudioHandle = null;
        this.programAudio.set(null);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const preview of [...previews].reverse()) {
      const meter = this.meters.get(preview.forkId);
      if (meter) {
        try {
          await meter.close();
          this.meters.delete(preview.forkId);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.capture.release(preview);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  }
}
