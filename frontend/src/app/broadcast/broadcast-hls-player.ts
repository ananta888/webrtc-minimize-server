import Hls, { Events } from "hls.js";
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

type HlsModule = Readonly<{ default: typeof Hls; Events: typeof Events }>;
type HlsLoader = (signal?: AbortSignal) => Promise<HlsModule>;

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

const HLS_STARTUP_TIMEOUT_MS = 20_000;
const HLS_MODULE_RETRY_DELAY_MS = 250;
const HLS_MODULE_TIMEOUT_MS = 5000;

function validateManifestUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value, location.origin);
  } catch {
    throw new BroadcastBrowserPortError("invalid_broadcast_manifest_url");
  }
  const localDevelopment = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(localDevelopment && parsed.protocol === "http:"))
    || parsed.origin !== location.origin
    || parsed.username || parsed.password || parsed.hash || parsed.search
    || !/^\/broadcast\/play\/res_[A-Za-z0-9_-]{16,64}\/(?:index|master)\.m3u8$/.test(parsed.pathname)) {
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
  private abortSignal: AbortSignal | null = null;
  private engineLoadAbort: AbortController | null = null;
  private generation = 0;
  private terminal = false;
  private listeners: Array<readonly [keyof HTMLMediaElementEventMap, EventListener]> = [];
  private captionPoll: ReturnType<typeof setInterval> | null = null;
  private captionController: AbortController | null = null;
  private captionTrack: HTMLTrackElement | null = null;
  private captionObjectUrl = "";
  private captionBody = "";
  private captionsVisible = false;
  private readonly qualityPolicy = new BroadcastViewerQualityPolicy("auto");

  constructor(
    private readonly onState: (snapshot: BroadcastPlayerSnapshot) => void = () => undefined,
    private readonly loadHls: HlsLoader = async () => ({ default: Hls, Events }),
  ) {}

  snapshot(): BroadcastPlayerSnapshot { return this.snapshotValue; }

  async open(
    video: HTMLVideoElement,
    manifestUrl: string,
    options: Readonly<{ muted: boolean; volume: number; captions?: boolean }>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.video) throw new BroadcastBrowserPortError("broadcast_player_busy");
    signal.throwIfAborted();
    const source = validateManifestUrl(manifestUrl);
    if (typeof options.muted !== "boolean" || !Number.isFinite(options.volume)
      || options.volume < 0 || options.volume > 1) {
      throw new BroadcastBrowserPortError("invalid_broadcast_player_options");
    }
    const generation = ++this.generation;
    this.video = video;
    video.muted = options.muted;
    video.volume = options.volume;
    video.playsInline = true;
    this.update({ lifecycle: "loading", errorCode: "" });
    this.installMediaListeners(video);
    this.abortListener = () => { if (generation === this.generation) void this.destroy(); };
    this.abortSignal = signal;
    signal.addEventListener("abort", this.abortListener, { once: true });
    try {
      const module = await this.loadHlsModule(signal);
      signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException("player-superseded", "AbortError");
      if (module.default.isSupported()) {
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
          if (generation !== this.generation) return;
          this.update({ qualities: qualities(hls.levels) });
        });
        hls.on(module.Events.LEVEL_SWITCHED, () => { if (generation === this.generation) this.updateLiveEdge(); });
        hls.on(module.Events.ERROR, (_event, data) => { if (generation === this.generation) this.handleHlsError(data); });
        hls.attachMedia(video);
        const manifestReady = this.waitForHlsManifest(hls, module, signal);
        hls.loadSource(source);
        this.update({ engine: "hls-js" });
        await manifestReady;
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        this.update({ engine: "native-hls" });
        video.src = source;
      } else {
        throw new BroadcastBrowserPortError("broadcast_hls_unsupported");
      }
      signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException("player-superseded", "AbortError");
      if (options.captions === true) this.startCaptionPolling(source);
      this.startWatchdog();
      await this.play();
    } catch (error) {
      if (generation !== this.generation) throw new DOMException("player-superseded", "AbortError");
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
    const generation = this.generation;
    if (!video) throw new BroadcastBrowserPortError("broadcast_player_not_open");
    if (this.terminal) throw new BroadcastBrowserPortError(this.snapshotValue.errorCode || "broadcast_ended");
    try {
      await video.play();
      if (generation !== this.generation || this.terminal) return;
      if (this.snapshotValue.lifecycle !== "failed") {
        this.update({ lifecycle: "playing", errorCode: "" });
      }
    } catch (error) {
      if (generation !== this.generation || this.terminal) return;
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

  setCaptionsVisible(visible: boolean): void {
    this.captionsVisible = visible;
    if (this.captionTrack?.track) this.captionTrack.track.mode = visible ? "showing" : "disabled";
  }

  selectQuality(value: "auto" | number): void {
    if (this.terminal) return;
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
    if (this.terminal) return;
    this.qualityPolicy.setMode(mode);
    if (this.hls) this.hls.currentLevel = -1;
    this.update({ adaptiveMode: mode, selectedQuality: "auto" });
  }

  adaptQuality(sample = this.qualitySample()): void {
    if (this.terminal || !this.hls || this.snapshotValue.qualities.length < 1
      || this.snapshotValue.selectedQuality !== "auto") return;
    const decision = this.qualityPolicy.evaluate(this.snapshotValue.qualities, sample);
    if (decision.changed || this.snapshotValue.adaptiveMode !== "auto") {
      this.hls.nextLevel = decision.targetIndex;
    }
    this.update({ adaptationReason: decision.reason });
  }

  async destroy(): Promise<void> {
    ++this.generation;
    this.engineLoadAbort?.abort(new DOMException("player-superseded", "AbortError"));
    if (this.abortListener) this.abortSignal?.removeEventListener("abort", this.abortListener);
    this.abortSignal = null;
    this.abortListener = null;
    const video = this.video;
    if (!video) return;
    this.stopLoading();
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
    this.terminal = false;
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

  private startCaptionPolling(manifestUrl: string): void {
    if (this.terminal) return;
    const generation = this.generation;
    const url = new URL(manifestUrl);
    url.pathname = url.pathname.replace(/\/(?:index|master)\.m3u8$/, "/captions_live.vtt");
    const poll = async () => {
      if (!this.video || this.captionController) return;
      const controller = new AbortController();
      this.captionController = controller;
      try {
        const response = await fetch(url.href, {
          method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== this.generation) return;
        if (!response.ok) {
          if (response.status === 404) this.clearCaptionTrack();
          return;
        }
        if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/vtt") return;
        const raw = await response.arrayBuffer();
        if (raw.byteLength < 8 || raw.byteLength > 64 * 1024) return;
        const body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        if (controller.signal.aborted || generation !== this.generation
          || !body.startsWith("WEBVTT\n\n") || body === this.captionBody || !this.video) return;
        const nextUrl = URL.createObjectURL(new Blob([body], { type: "text/vtt" }));
        const previousUrl = this.captionObjectUrl;
        let track = this.captionTrack;
        if (!track) {
          track = document.createElement("track");
          track.kind = "captions";
          track.label = "Live-Untertitel";
          track.srclang = "de";
          track.dataset["broadcastPlayer"] = "true";
          this.video.appendChild(track);
          this.captionTrack = track;
        }
        track.src = nextUrl;
        if (track.track) track.track.mode = this.captionsVisible ? "showing" : "disabled";
        this.captionObjectUrl = nextUrl;
        this.captionBody = body;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
      } catch {
        // Missing, revoked or temporarily unavailable captions do not fail media playback.
      } finally {
        if (this.captionController === controller) this.captionController = null;
      }
    };
    void poll();
    this.captionPoll = setInterval(() => { void poll(); }, 2_000);
  }

  private clearCaptionTrack(): void {
    this.captionTrack?.remove();
    this.captionTrack = null;
    this.captionBody = "";
    if (this.captionObjectUrl) URL.revokeObjectURL(this.captionObjectUrl);
    this.captionObjectUrl = "";
  }

  private startWatchdog(): void {
    if (this.terminal) return;
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

  private recover(reason: "stall" | "network" | "media"): void {
    const video = this.video;
    if (!video || this.terminal) return;
    const now = Date.now();
    this.recoveries = this.recoveries.filter((value) => value > now - 30_000);
    if (this.recoveries.length >= 2) {
      this.update({ lifecycle: "failed", errorCode: "broadcast_player_recovery_exhausted" });
      return;
    }
    this.recoveries.push(now);
    this.stalledSamples = 0;
    this.update({ lifecycle: "recovering", recoveryCount: this.recoveries.length });
    if (reason === "media") this.hls?.recoverMediaError();
    const live = this.hls?.liveSyncPosition;
    const seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
    const target = typeof live === "number" ? live : seekableEnd === null ? null : Math.max(0, seekableEnd - 2);
    if (target !== null && target - video.currentTime > 1) video.currentTime = target;
    this.hls?.startLoad(-1);
    void this.play().catch(() => this.update({ lifecycle: "failed", errorCode: "broadcast_player_recovery_failed" }));
  }

  private handleHlsError(data: ErrorData): void {
    if (this.terminal) return;
    const status = Number(data.response?.code || 0);
    if (data.type === "networkError" && [401, 403, 404, 410].includes(status)) {
      this.update({ lifecycle: "ended", errorCode: "broadcast_ended" });
    } else if (data.type === "networkError" && status === 429) {
      this.update({ lifecycle: "failed", errorCode: "broadcast_player_rate_limited" });
    } else if (!data.fatal) return;
    else if (data.type === "networkError") this.recover("network");
    else if (data.type === "mediaError" && this.hls) {
      this.recover("media");
    } else this.update({ lifecycle: "failed", errorCode: "broadcast_player_hls_failed" });
  }

  private waitForHlsManifest(hls: Hls, module: HlsModule, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: BroadcastBrowserPortError | DOMException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        hls.off(module.Events.MANIFEST_PARSED, onManifest);
        hls.off(module.Events.ERROR, onError);
        if (error) reject(error);
        else resolve();
      };
      const onManifest = () => finish();
      const onError = (_event: string, data: ErrorData) => {
        if (data.fatal) finish(new BroadcastBrowserPortError(
          data.type === "networkError" ? "broadcast_player_manifest_unavailable" : "broadcast_player_manifest_failed",
        ));
      };
      const onAbort = () => finish(signal.reason instanceof DOMException
        ? signal.reason : new DOMException("aborted", "AbortError"));
      const timeout = setTimeout(
        () => finish(new BroadcastBrowserPortError("broadcast_player_manifest_timeout")),
        HLS_STARTUP_TIMEOUT_MS,
      );
      hls.on(module.Events.MANIFEST_PARSED, onManifest);
      hls.on(module.Events.ERROR, onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async loadHlsModule(signal: AbortSignal): Promise<HlsModule> {
    const controller = new AbortController();
    this.engineLoadAbort = controller;
    const abort = () => controller.abort(new DOMException("player-aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    let rejectLoad: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectLoad = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectLoad, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(new BroadcastBrowserPortError("broadcast_player_engine_unavailable")), HLS_MODULE_TIMEOUT_MS);
    if (signal.aborted) abort();
    try {
      return await Promise.race([this.retryHlsModule(controller.signal), cancelled]);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectLoad);
      if (this.engineLoadAbort === controller) this.engineLoadAbort = null;
      controller.abort(); // Retire a losing/non-cooperative attempt; never attach its late result.
    }
  }

  private async retryHlsModule(signal: AbortSignal): Promise<HlsModule> {
    try {
      signal.throwIfAborted();
      return await this.loadHls(signal);
    } catch {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(), HLS_MODULE_RETRY_DELAY_MS);
        const abort = () => finish(signal.reason instanceof DOMException
          ? signal.reason : new DOMException("aborted", "AbortError"));
        const finish = (error?: DOMException) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        signal.throwIfAborted();
        return await this.loadHls(signal);
      } catch {
        signal.throwIfAborted();
        throw new BroadcastBrowserPortError("broadcast_player_engine_unavailable");
      }
    }
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

  private stopLoading(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.captionPoll) clearInterval(this.captionPoll);
    this.captionPoll = null;
    this.captionController?.abort(new DOMException("player-stopped", "AbortError"));
    this.captionController = null;
    this.clearCaptionTrack();
    this.hls?.stopLoad();
  }

  private update(change: Partial<BroadcastPlayerSnapshot>): void {
    if (this.terminal) return;
    this.snapshotValue = Object.freeze({ ...this.snapshotValue, ...change });
    if (change.lifecycle === "failed" || change.lifecycle === "ended") {
      this.terminal = true;
      this.stopLoading();
      this.video?.pause();
    }
    this.onState(this.snapshotValue);
  }
}
