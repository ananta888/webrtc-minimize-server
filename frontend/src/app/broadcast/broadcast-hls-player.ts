import type Hls from "hls.js";
import type { ErrorData, HlsConfig, Level } from "hls.js";

import { BroadcastBrowserPortError } from "./broadcast-ports";
import {
  BroadcastViewerQualityMode,
  BroadcastViewerQualityPolicy,
  BroadcastViewerQualitySample,
} from "./broadcast-viewer-quality-policy";

export type BroadcastPlayerLifecycle = "idle" | "loading" | "awaiting-user" | "playing" | "recovering" | "ended" | "failed";
export type BroadcastPlayerEngine = "native-hls" | "hls-js";

export interface BroadcastPlayerQuality {
  readonly index: number;
  readonly height: number;
  readonly bitrate: number;
  readonly label: string;
}

export interface BroadcastPlayerSnapshot {
  readonly lifecycle: BroadcastPlayerLifecycle;
  readonly engine: BroadcastPlayerEngine | null;
  readonly qualities: readonly BroadcastPlayerQuality[];
  readonly selectedQuality: "auto" | number;
  readonly adaptiveMode: BroadcastViewerQualityMode;
  readonly adaptationReason: string;
  readonly liveEdgeDistanceSeconds: number | null;
  readonly recoveryCount: number;
  readonly errorCode: string;
}

type HlsModule = typeof import("hls.js");
type HlsLoader = () => Promise<HlsModule>;

const initialSnapshot = (): BroadcastPlayerSnapshot => Object.freeze({
  lifecycle: "idle",
  engine: null,
  qualities: Object.freeze([]),
  selectedQuality: "auto",
  adaptiveMode: "auto",
  adaptationReason: "stable",
  liveEdgeDistanceSeconds: null,
  recoveryCount: 0,
  errorCode: "",
});

function validateManifestUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value, location.origin);
  } catch {
    throw new BroadcastBrowserPortError("invalid_broadcast_manifest_url");
  }
  const localDevelopment = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(localDevelopment && parsed.protocol === "http:"))
    || parsed.username || parsed.password || parsed.hash || parsed.search
    || !/^\/res_[A-Za-z0-9_-]{16,64}\/(?:index|master)\.m3u8$/.test(parsed.pathname)) {
    throw new BroadcastBrowserPortError("invalid_broadcast_manifest_url");
  }
  return parsed.href;
}

function qualities(levels: readonly Level[]): readonly BroadcastPlayerQuality[] {
  return Object.freeze(levels.map((level, index) => Object.freeze({
    index,
    height: Number.isFinite(level.height) ? level.height : 0,
    bitrate: Number.isFinite(level.bitrate) ? level.bitrate : 0,
    label: level.height ? `${level.height}p` : `Stufe ${index + 1}`,
  })));
}

export class BroadcastHlsPlayer {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private snapshotValue = initialSnapshot();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastTime = -1;
  private stalledSamples = 0;
  private recoveries: number[] = [];
  private abortListener: (() => void) | null = null;
  private listeners: Array<readonly [keyof HTMLMediaElementEventMap, EventListener]> = [];
  private readonly qualityPolicy = new BroadcastViewerQualityPolicy("auto");

  constructor(
    private readonly onState: (snapshot: BroadcastPlayerSnapshot) => void = () => undefined,
    private readonly loadHls: HlsLoader = () => import("hls.js"),
  ) {}

  snapshot(): BroadcastPlayerSnapshot { return this.snapshotValue; }

  async open(
    video: HTMLVideoElement,
    manifestUrl: string,
    options: Readonly<{ muted: boolean; volume: number }>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.video) throw new BroadcastBrowserPortError("broadcast_player_busy");
    signal.throwIfAborted();
    const source = validateManifestUrl(manifestUrl);
    if (typeof options.muted !== "boolean" || !Number.isFinite(options.volume)
      || options.volume < 0 || options.volume > 1) {
      throw new BroadcastBrowserPortError("invalid_broadcast_player_options");
    }
    this.video = video;
    video.muted = options.muted;
    video.volume = options.volume;
    video.playsInline = true;
    this.update({ lifecycle: "loading", errorCode: "" });
    this.installMediaListeners(video);
    this.abortListener = () => { void this.destroy(); };
    signal.addEventListener("abort", this.abortListener, { once: true });
    try {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        this.update({ engine: "native-hls" });
        video.src = source;
      } else {
        const module = await this.loadHls();
        signal.throwIfAborted();
        if (!module.default.isSupported()) throw new BroadcastBrowserPortError("broadcast_hls_unsupported");
        const config: Partial<HlsConfig> = {
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 20,
          maxMaxBufferLength: 30,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 6,
          xhrSetup: (xhr) => { xhr.withCredentials = true; },
        };
        const hls = new module.default(config);
        this.hls = hls;
        hls.on(module.Events.MANIFEST_PARSED, () => {
          this.update({ qualities: qualities(hls.levels) });
        });
        hls.on(module.Events.LEVEL_SWITCHED, () => this.updateLiveEdge());
        hls.on(module.Events.ERROR, (_event, data) => this.handleHlsError(data));
        hls.attachMedia(video);
        hls.loadSource(source);
        this.update({ engine: "hls-js" });
      }
      this.startWatchdog();
      await this.play();
    } catch (error) {
      if (signal.aborted) {
        await this.destroy();
        signal.throwIfAborted();
      }
      this.update({ lifecycle: "failed", errorCode: this.publicError(error) });
      throw error;
    }
  }

  async play(): Promise<void> {
    const video = this.video;
    if (!video) throw new BroadcastBrowserPortError("broadcast_player_not_open");
    try {
      await video.play();
      if (this.snapshotValue.lifecycle !== "failed") {
        this.update({ lifecycle: "playing", errorCode: "" });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.update({ lifecycle: "awaiting-user", errorCode: "broadcast_player_user_activation_required" });
        return;
      }
      throw error;
    }
  }

  setMuted(muted: boolean): void {
    if (!this.video) return;
    this.video.muted = muted;
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new BroadcastBrowserPortError("invalid_broadcast_player_volume");
    }
    if (this.video) this.video.volume = volume;
  }

  selectQuality(value: "auto" | number): void {
    if (value !== "auto" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_player_quality");
    }
    if (this.hls) {
      if (value !== "auto" && !this.snapshotValue.qualities.some(({ index }) => index === value)) {
        throw new BroadcastBrowserPortError("unknown_broadcast_player_quality");
      }
      this.hls.currentLevel = value === "auto" ? -1 : value;
    } else if (value !== "auto") {
      throw new BroadcastBrowserPortError("native_hls_quality_is_automatic");
    }
    this.update({ selectedQuality: value });
  }

  setAdaptiveMode(mode: BroadcastViewerQualityMode): void {
    this.qualityPolicy.setMode(mode);
    if (this.hls) this.hls.currentLevel = -1;
    this.update({ adaptiveMode: mode, selectedQuality: "auto" });
  }

  adaptQuality(sample = this.qualitySample()): void {
    if (!this.hls || this.snapshotValue.qualities.length < 1
      || this.snapshotValue.selectedQuality !== "auto") return;
    const decision = this.qualityPolicy.evaluate(this.snapshotValue.qualities, sample);
    if (decision.changed || this.snapshotValue.adaptiveMode !== "auto") {
      this.hls.nextLevel = decision.targetIndex;
    }
    this.update({ adaptationReason: decision.reason });
  }

  async destroy(): Promise<void> {
    const video = this.video;
    if (!video) return;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.hls?.stopLoad();
    this.hls?.destroy();
    this.hls = null;
    for (const [event, listener] of this.listeners) video.removeEventListener(event, listener);
    this.listeners = [];
    for (const track of Array.from(video.querySelectorAll("track[data-broadcast-player]"))) track.remove();
    video.pause();
    video.removeAttribute("src");
    video.load();
    this.video = null;
    this.lastTime = -1;
    this.stalledSamples = 0;
    this.recoveries = [];
    this.abortListener = null;
    this.snapshotValue = initialSnapshot();
    this.onState(this.snapshotValue);
  }

  private installMediaListeners(video: HTMLVideoElement): void {
    const listen = (event: keyof HTMLMediaElementEventMap, handler: EventListener) => {
      video.addEventListener(event, handler);
      this.listeners.push([event, handler]);
    };
    listen("playing", () => this.update({ lifecycle: "playing", errorCode: "" }));
    listen("ended", () => this.update({ lifecycle: "ended" }));
    listen("waiting", () => { this.stalledSamples = Math.max(this.stalledSamples, 2); });
    listen("error", () => this.update({ lifecycle: "failed", errorCode: "broadcast_player_media_failed" }));
    listen("timeupdate", () => this.updateLiveEdge());
  }

  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      const video = this.video;
      if (!video || video.paused || video.ended || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (Math.abs(video.currentTime - this.lastTime) < 0.05) this.stalledSamples += 1;
      else this.stalledSamples = 0;
      this.lastTime = video.currentTime;
      this.updateLiveEdge();
      this.adaptQuality();
      if (this.stalledSamples >= 3) this.recover("stall");
    }, 2_000);
  }

  private recover(_reason: "stall" | "network" | "media"): void {
    const video = this.video;
    if (!video) return;
    const now = Date.now();
    this.recoveries = this.recoveries.filter((value) => value > now - 30_000);
    if (this.recoveries.length >= 2) {
      this.update({ lifecycle: "failed", errorCode: "broadcast_player_recovery_exhausted" });
      return;
    }
    this.recoveries.push(now);
    this.stalledSamples = 0;
    this.update({ lifecycle: "recovering", recoveryCount: this.recoveries.length });
    const live = this.hls?.liveSyncPosition;
    const seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
    const target = typeof live === "number" ? live : seekableEnd === null ? null : Math.max(0, seekableEnd - 2);
    if (target !== null && target - video.currentTime > 1) video.currentTime = target;
    this.hls?.startLoad(-1);
    void this.play().catch(() => this.update({ lifecycle: "failed", errorCode: "broadcast_player_recovery_failed" }));
  }

  private handleHlsError(data: ErrorData): void {
    if (!data.fatal) return;
    if (data.type === "networkError") this.recover("network");
    else if (data.type === "mediaError" && this.hls) {
      this.hls.recoverMediaError();
      this.recover("media");
    } else this.update({ lifecycle: "failed", errorCode: "broadcast_player_hls_failed" });
  }

  private updateLiveEdge(): void {
    const video = this.video;
    if (!video) return;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
    this.update({ liveEdgeDistanceSeconds: end === null ? null : Math.max(0, end - video.currentTime) });
  }

  private publicError(error: unknown): string {
    return error instanceof BroadcastBrowserPortError ? error.code : "broadcast_player_open_failed";
  }

  private qualitySample(): BroadcastViewerQualitySample {
    const video = this.video;
    const quality = video?.getVideoPlaybackQuality?.();
    const bufferedEnd = video?.buffered.length ? video.buffered.end(video.buffered.length - 1) : video?.currentTime || 0;
    const connection = (navigator as Navigator & {
      connection?: { readonly saveData?: boolean; readonly downlink?: number };
    }).connection;
    const hlsBandwidth = Number((this.hls as unknown as { bandwidthEstimate?: number } | null)?.bandwidthEstimate || 0);
    const connectionBandwidth = Number(connection?.downlink || 0) * 1_000_000;
    return {
      sampledAt: Date.now(),
      bandwidthEstimateBitsPerSecond: Number.isFinite(hlsBandwidth) && hlsBandwidth > 0
        ? hlsBandwidth : Number.isFinite(connectionBandwidth) ? connectionBandwidth : 0,
      bufferSeconds: Math.max(0, bufferedEnd - (video?.currentTime || 0)),
      decodedFrames: Math.max(0, Math.round(quality?.totalVideoFrames || 0)),
      droppedFrames: Math.max(0, Math.round(quality?.droppedVideoFrames || 0)),
      lowPowerMode: Boolean(connection?.saveData),
    };
  }

  private update(change: Partial<BroadcastPlayerSnapshot>): void {
    this.snapshotValue = Object.freeze({ ...this.snapshotValue, ...change });
    this.onState(this.snapshotValue);
  }
}
