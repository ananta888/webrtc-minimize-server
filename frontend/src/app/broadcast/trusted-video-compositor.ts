import { InjectionToken, Injectable, signal } from "@angular/core";

import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";

export type TrustedVideoLayout =
  | "single"
  | "screen-presenter"
  | "side-by-side"
  | "active-speaker"
  | "grid"
  | "waiting-slate"
  | "end-slate";
export type TrustedVideoFit = "contain" | "cover";
export type TrustedVideoProfileId = "bandwidth" | "balanced" | "screen-text" | "quality";

export interface TrustedVideoProfile {
  readonly profileVersion: 1;
  readonly profileId: TrustedVideoProfileId;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly cameraFit: TrustedVideoFit;
  readonly screenFit: TrustedVideoFit;
  readonly cameraThumbnailFloor: number;
  readonly background: string;
}

export interface TrustedVideoOverlayPolicy {
  readonly policyVersion: 1;
  readonly showSourceLabels: boolean;
  readonly showProgramTitle: boolean;
  readonly showCaptions: boolean;
  readonly programTitle: string;
  readonly captionText: string;
}

export interface TrustedVideoInput {
  readonly sourceId: string;
  readonly sourceKind: "camera" | "screen";
  readonly stream: MediaStream;
  readonly label?: string;
}

export interface TrustedVideoRect {
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fit: TrustedVideoFit;
  readonly layer: "primary" | "secondary";
}

export interface TrustedVideoSnapshot {
  readonly layout: TrustedVideoLayout;
  readonly profileId: TrustedVideoProfileId;
  readonly width: number;
  readonly height: number;
  readonly targetFramesPerSecond: number;
  readonly effectiveFramesPerSecond: number;
  readonly framesRendered: number;
  readonly framesSkipped: number;
  readonly sourceCount: number;
  readonly degradedReason: "none" | "hidden-tab" | "render-backpressure" | "source-ended";
}

export interface TrustedVideoCompositorHandle {
  readonly outputSourceId: string;
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  snapshot(): TrustedVideoSnapshot;
  setLayout(layout: TrustedVideoLayout, activeSourceId?: string): void;
  setOverlay(policy: TrustedVideoOverlayPolicy): void;
  close(): Promise<void>;
}

export interface TrustedVideoCompositorFactory {
  readonly supported: boolean;
  create(
    program: BroadcastProgramRef,
    inputs: readonly TrustedVideoInput[],
    profile: TrustedVideoProfile,
    layout: TrustedVideoLayout,
    overlay: TrustedVideoOverlayPolicy,
    signal: AbortSignal,
  ): Promise<TrustedVideoCompositorHandle>;
}

export const TRUSTED_VIDEO_PROFILES: Readonly<Record<TrustedVideoProfileId, TrustedVideoProfile>> =
  Object.freeze({
    bandwidth: Object.freeze({
      profileVersion: 1, profileId: "bandwidth", width: 960, height: 540,
      framesPerSecond: 12, cameraFit: "cover", screenFit: "contain",
      cameraThumbnailFloor: 0.24, background: "#09131f",
    }),
    balanced: Object.freeze({
      profileVersion: 1, profileId: "balanced", width: 1280, height: 720,
      framesPerSecond: 24, cameraFit: "cover", screenFit: "contain",
      cameraThumbnailFloor: 0.22, background: "#09131f",
    }),
    "screen-text": Object.freeze({
      profileVersion: 1, profileId: "screen-text", width: 1920, height: 1080,
      framesPerSecond: 15, cameraFit: "cover", screenFit: "contain",
      cameraThumbnailFloor: 0.2, background: "#05090f",
    }),
    quality: Object.freeze({
      profileVersion: 1, profileId: "quality", width: 1920, height: 1080,
      framesPerSecond: 30, cameraFit: "cover", screenFit: "contain",
      cameraThumbnailFloor: 0.2, background: "#09131f",
    }),
  });

const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const LAYOUTS = new Set<TrustedVideoLayout>([
  "single", "screen-presenter", "side-by-side", "active-speaker", "grid",
  "waiting-slate", "end-slate",
]);

function fail(code: string): never {
  throw new BroadcastBrowserPortError(code);
}

function generatedSourceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `src_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("invalid_trusted_video_overlay");
  }
  return value;
}

export function normalizeTrustedVideoOverlay(value: TrustedVideoOverlayPolicy): TrustedVideoOverlayPolicy {
  if (!value || value.policyVersion !== 1
    || typeof value.showSourceLabels !== "boolean"
    || typeof value.showProgramTitle !== "boolean"
    || typeof value.showCaptions !== "boolean") fail("invalid_trusted_video_overlay");
  return Object.freeze({
    policyVersion: 1,
    showSourceLabels: value.showSourceLabels,
    showProgramTitle: value.showProgramTitle,
    showCaptions: value.showCaptions,
    programTitle: boundedText(value.programTitle, 100),
    captionText: boundedText(value.captionText, 240),
  });
}

export function trustedVideoLayoutRects(
  layout: TrustedVideoLayout,
  inputs: readonly Pick<TrustedVideoInput, "sourceId" | "sourceKind">[],
  width: number,
  height: number,
  profile: TrustedVideoProfile,
  activeSourceId = "",
): readonly TrustedVideoRect[] {
  if (!LAYOUTS.has(layout) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 320 || height < 180 || inputs.length > 4) fail("invalid_trusted_video_layout");
  if (layout === "waiting-slate" || layout === "end-slate" || inputs.length === 0) return Object.freeze([]);
  const fit = (sourceKind: "camera" | "screen") => sourceKind === "screen" ? profile.screenFit : profile.cameraFit;
  const rect = (input: typeof inputs[number], x: number, y: number, w: number, h: number, layer: "primary" | "secondary") =>
    Object.freeze({ sourceId: input.sourceId, x, y, width: w, height: h, fit: fit(input.sourceKind), layer });
  if (layout === "single") return Object.freeze([rect(inputs[0], 0, 0, width, height, "primary")]);
  if (layout === "screen-presenter") {
    const screen = inputs.find(({ sourceKind }) => sourceKind === "screen") || inputs[0];
    const presenter = inputs.find(({ sourceKind, sourceId }) => sourceKind === "camera" && sourceId !== screen.sourceId);
    if (!presenter) return Object.freeze([rect(screen, 0, 0, width, height, "primary")]);
    const padding = Math.round(width * 0.02);
    const thumbnailWidth = Math.max(Math.round(width * profile.cameraThumbnailFloor), 240);
    const thumbnailHeight = Math.round(thumbnailWidth * 9 / 16);
    return Object.freeze([
      rect(screen, 0, 0, width, height, "primary"),
      rect(presenter, width - thumbnailWidth - padding, height - thumbnailHeight - padding,
        thumbnailWidth, thumbnailHeight, "secondary"),
    ]);
  }
  if (layout === "active-speaker") {
    const active = inputs.find(({ sourceId }) => sourceId === activeSourceId) || inputs[0];
    const remaining = inputs.filter(({ sourceId }) => sourceId !== active.sourceId);
    const stripWidth = remaining.length ? Math.max(Math.round(width * profile.cameraThumbnailFloor), 240) : 0;
    const cellHeight = remaining.length ? Math.floor(height / remaining.length) : 0;
    return Object.freeze([
      rect(active, 0, 0, width - stripWidth, height, "primary"),
      ...remaining.map((input, index) => rect(input, width - stripWidth, index * cellHeight,
        stripWidth, index === remaining.length - 1 ? height - index * cellHeight : cellHeight, "secondary")),
    ]);
  }
  const columns = layout === "side-by-side" ? Math.min(2, inputs.length) : Math.ceil(Math.sqrt(inputs.length));
  const rows = Math.ceil(inputs.length / columns);
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  return Object.freeze(inputs.map((input, index) => rect(
    input,
    (index % columns) * cellWidth,
    Math.floor(index / columns) * cellHeight,
    index % columns === columns - 1 ? width - (index % columns) * cellWidth : cellWidth,
    Math.floor(index / columns) === rows - 1 ? height - Math.floor(index / columns) * cellHeight : cellHeight,
    index === 0 ? "primary" : "secondary",
  )));
}

function drawFitted(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  rectangle: TrustedVideoRect,
): void {
  const sourceWidth = video.videoWidth || rectangle.width;
  const sourceHeight = video.videoHeight || rectangle.height;
  const scale = rectangle.fit === "contain"
    ? Math.min(rectangle.width / sourceWidth, rectangle.height / sourceHeight)
    : Math.max(rectangle.width / sourceWidth, rectangle.height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.save();
  context.beginPath();
  context.rect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  context.clip();
  context.drawImage(video, rectangle.x + (rectangle.width - drawWidth) / 2,
    rectangle.y + (rectangle.height - drawHeight) / 2, drawWidth, drawHeight);
  context.restore();
}

export class BrowserTrustedVideoCompositorFactory implements TrustedVideoCompositorFactory {
  readonly supported = typeof document !== "undefined"
    && typeof HTMLCanvasElement !== "undefined"
    && typeof HTMLCanvasElement.prototype.captureStream === "function";

  async create(
    program: BroadcastProgramRef,
    inputs: readonly TrustedVideoInput[],
    profile: TrustedVideoProfile,
    layout: TrustedVideoLayout,
    overlayValue: TrustedVideoOverlayPolicy,
    signal: AbortSignal,
  ): Promise<TrustedVideoCompositorHandle> {
    if (!this.supported) fail("trusted_video_compositor_unsupported");
    signal.throwIfAborted();
    if (!program || program.programEpoch < 1 || !Object.values(TRUSTED_VIDEO_PROFILES).includes(profile)
      || !LAYOUTS.has(layout) || inputs.length < 1 || inputs.length > 4
      || new Set(inputs.map(({ sourceId }) => sourceId)).size !== inputs.length
      || inputs.some(({ sourceId, sourceKind, stream }) => !SOURCE_ID.test(sourceId)
        || (sourceKind !== "camera" && sourceKind !== "screen")
        || stream.getVideoTracks().length !== 1 || stream.getVideoTracks()[0].readyState !== "live")) {
      fail("invalid_trusted_video_program");
    }
    const canvas = document.createElement("canvas");
    canvas.width = profile.width;
    canvas.height = profile.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) fail("trusted_video_canvas_unavailable");
    const videos = new Map<string, { input: TrustedVideoInput; video: HTMLVideoElement; track: MediaStreamTrack; ended: () => void }>();
    let currentLayout = layout;
    let activeSourceId = inputs[0].sourceId;
    let overlay = normalizeTrustedVideoOverlay(overlayValue);
    let closed = false;
    let timer = 0;
    let framesRendered = 0;
    let framesSkipped = 0;
    let slowFrames = 0;
    let sourceEnded = false;
    let effectiveFramesPerSecond = profile.framesPerSecond;
    try {
      for (const input of inputs) {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = input.stream;
        const track = input.stream.getVideoTracks()[0];
        const ended = () => {
          sourceEnded = true;
          videos.delete(input.sourceId);
          video.pause();
          video.srcObject = null;
        };
        track.addEventListener("ended", ended, { once: true });
        videos.set(input.sourceId, { input, video, track, ended });
        await video.play();
        signal.throwIfAborted();
      }
      const output = canvas.captureStream(profile.framesPerSecond);
      const outputTracks = output.getVideoTracks();
      if (outputTracks.length !== 1) fail("trusted_video_output_unavailable");
      const track = outputTracks[0];
      try { track.contentHint = inputs.some(({ sourceKind }) => sourceKind === "screen") ? "detail" : "motion"; } catch { /* optional */ }

      const drawOverlay = () => {
        context.textBaseline = "bottom";
        if (overlay.showProgramTitle && overlay.programTitle) {
          context.fillStyle = "rgba(0,0,0,.66)";
          context.fillRect(0, 0, canvas.width, 58);
          context.fillStyle = "#fff";
          context.font = "600 28px system-ui, sans-serif";
          context.fillText(overlay.programTitle, 24, 43, canvas.width - 48);
        }
        if (overlay.showCaptions && overlay.captionText) {
          context.fillStyle = "rgba(0,0,0,.78)";
          context.fillRect(40, canvas.height - 100, canvas.width - 80, 72);
          context.fillStyle = "#fff";
          context.font = "600 30px system-ui, sans-serif";
          context.textAlign = "center";
          context.fillText(overlay.captionText, canvas.width / 2, canvas.height - 47, canvas.width - 120);
          context.textAlign = "start";
        }
      };
      const draw = () => {
        if (closed) return;
        const started = performance.now();
        context.fillStyle = profile.background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        const available = [...videos.values()].map(({ input }) => input);
        const slate = currentLayout === "waiting-slate" || currentLayout === "end-slate" || available.length === 0;
        if (slate) {
          context.fillStyle = "#e8f0f7";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.font = "600 42px system-ui, sans-serif";
          context.fillText(currentLayout === "end-slate" ? "Sendung beendet" : "Sendung beginnt gleich",
            canvas.width / 2, canvas.height / 2, canvas.width - 80);
          context.textAlign = "start";
        } else {
          const rectangles = trustedVideoLayoutRects(currentLayout, available, canvas.width, canvas.height, profile, activeSourceId);
          for (const rectangle of rectangles) {
            const entry = videos.get(rectangle.sourceId);
            if (!entry || entry.video.readyState < 2) {
              framesSkipped += 1;
              continue;
            }
            drawFitted(context, entry.video, rectangle);
            if (overlay.showSourceLabels && entry.input.label) {
              context.fillStyle = "rgba(0,0,0,.7)";
              context.fillRect(rectangle.x + 12, rectangle.y + rectangle.height - 46, 240, 34);
              context.fillStyle = "#fff";
              context.font = "500 18px system-ui, sans-serif";
              context.textBaseline = "bottom";
              context.fillText(entry.input.label.slice(0, 64), rectangle.x + 22, rectangle.y + rectangle.height - 20, 220);
            }
          }
        }
        drawOverlay();
        framesRendered += 1;
        const elapsed = performance.now() - started;
        slowFrames = elapsed > 1_000 / effectiveFramesPerSecond ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames >= 5) {
          effectiveFramesPerSecond = Math.max(5, Math.floor(effectiveFramesPerSecond * 0.75));
          slowFrames = 0;
        } else if (slowFrames === 0 && effectiveFramesPerSecond < profile.framesPerSecond && framesRendered % 60 === 0) {
          effectiveFramesPerSecond = Math.min(profile.framesPerSecond, effectiveFramesPerSecond + 1);
        }
        const nextRate = document.hidden ? Math.min(5, effectiveFramesPerSecond) : effectiveFramesPerSecond;
        timer = window.setTimeout(draw, Math.round(1_000 / nextRate));
      };
      draw();
      const close = async () => {
        if (closed) return;
        closed = true;
        window.clearTimeout(timer);
        for (const { video, track: inputTrack, ended } of videos.values()) {
          inputTrack.removeEventListener("ended", ended);
          video.pause();
          video.srcObject = null;
        }
        videos.clear();
        if (track.readyState !== "ended") track.stop();
        canvas.width = 1;
        canvas.height = 1;
      };
      const abort = () => { void close(); };
      signal.addEventListener("abort", abort, { once: true });
      return Object.freeze({
        outputSourceId: generatedSourceId(), stream: output, track,
        snapshot: () => Object.freeze({
          layout: currentLayout, profileId: profile.profileId,
          width: profile.width, height: profile.height,
          targetFramesPerSecond: profile.framesPerSecond,
          effectiveFramesPerSecond: document.hidden ? Math.min(5, effectiveFramesPerSecond) : effectiveFramesPerSecond,
          framesRendered, framesSkipped, sourceCount: videos.size,
          degradedReason: document.hidden ? "hidden-tab"
            : effectiveFramesPerSecond < profile.framesPerSecond ? "render-backpressure"
              : sourceEnded ? "source-ended" : "none",
        }),
        setLayout(nextLayout: TrustedVideoLayout, nextActiveSourceId = "") {
          if (!LAYOUTS.has(nextLayout)
            || (nextActiveSourceId && !videos.has(nextActiveSourceId))) fail("invalid_trusted_video_layout");
          currentLayout = nextLayout;
          if (nextActiveSourceId) activeSourceId = nextActiveSourceId;
        },
        setOverlay(value: TrustedVideoOverlayPolicy) { overlay = normalizeTrustedVideoOverlay(value); },
        close: async () => {
          signal.removeEventListener("abort", abort);
          await close();
        },
      });
    } catch (error) {
      window.clearTimeout(timer);
      for (const { video, track, ended } of videos.values()) {
        track.removeEventListener("ended", ended);
        video.pause();
        video.srcObject = null;
      }
      videos.clear();
      canvas.width = 1;
      canvas.height = 1;
      throw error;
    }
  }
}

export const TRUSTED_VIDEO_COMPOSITOR_FACTORY = new InjectionToken<TrustedVideoCompositorFactory>(
  "TRUSTED_VIDEO_COMPOSITOR_FACTORY",
  { providedIn: "root", factory: () => new BrowserTrustedVideoCompositorFactory() },
);

@Injectable({ providedIn: "root" })
export class TrustedVideoProgramSettingsService {
  readonly profileId = signal<TrustedVideoProfileId>("balanced");
  readonly layout = signal<TrustedVideoLayout>("screen-presenter");

  profile(): TrustedVideoProfile { return TRUSTED_VIDEO_PROFILES[this.profileId()]; }

  setProfile(value: unknown): boolean {
    if (value !== "bandwidth" && value !== "balanced" && value !== "screen-text" && value !== "quality") return false;
    this.profileId.set(value);
    return true;
  }

  setLayout(value: unknown): boolean {
    if (!LAYOUTS.has(value as TrustedVideoLayout)) return false;
    this.layout.set(value as TrustedVideoLayout);
    return true;
  }

  overlay(): TrustedVideoOverlayPolicy {
    return Object.freeze({
      policyVersion: 1, showSourceLabels: false, showProgramTitle: false,
      showCaptions: false, programTitle: "", captionText: "",
    });
  }
}
