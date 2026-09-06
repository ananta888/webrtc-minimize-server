import { afterEach, describe, expect, it, vi } from "vitest";

import { BroadcastBrowserPortError } from "./broadcast-ports";
import {
  TRUSTED_VIDEO_PROFILES,
  BrowserTrustedVideoCompositorFactory,
  TrustedVideoProgramSettingsService,
  normalizeTrustedVideoOverlay,
  trustedVideoLayoutRects,
} from "./trusted-video-compositor";

const camera = { sourceId: "src_cameraaaaaaaaaaa", sourceKind: "camera" as const };
const screen = { sourceId: "src_screenaaaaaaaaaa", sourceKind: "screen" as const };
const secondCamera = { sourceId: "src_camerabbbbbbbbbb", sourceKind: "camera" as const };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("trustedVideoLayoutRects", () => {
  it("honors an explicitly selected single source and safely reflows when it ends", () => {
    const inputs = [camera, screen, secondCamera], profile = TRUSTED_VIDEO_PROFILES.balanced;
    expect(trustedVideoLayoutRects("single", inputs, 1280, 720, profile, screen.sourceId)[0])
      .toMatchObject({ sourceId: screen.sourceId, fit: "contain", width: 1280, height: 720 });
    expect(trustedVideoLayoutRects("single", [camera], 1280, 720, profile, screen.sourceId)[0].sourceId).toBe(camera.sourceId);
    expect(trustedVideoLayoutRects("single", inputs, 1280, 720, profile)[0].sourceId).toBe(camera.sourceId);
  });
  it("keeps screen text full-frame and a presenter above the configured thumbnail floor", () => {
    const profile = TRUSTED_VIDEO_PROFILES["screen-text"];
    const rectangles = trustedVideoLayoutRects("screen-presenter", [camera, screen], 1920, 1080, profile);
    expect(rectangles).toHaveLength(2);
    expect(rectangles[0]).toMatchObject({ sourceId: screen.sourceId, x: 0, y: 0, width: 1920, height: 1080, fit: "contain" });
    expect(rectangles[1].sourceId).toBe(camera.sourceId);
    expect(rectangles[1].width).toBeGreaterThanOrEqual(1920 * profile.cameraThumbnailFloor);
    expect(rectangles[1].fit).toBe("cover");
  });

  it("calculates bounded side-by-side, active-speaker and grid rectangles", () => {
    const profile = TRUSTED_VIDEO_PROFILES.balanced;
    const side = trustedVideoLayoutRects("side-by-side", [camera, screen], 1280, 720, profile);
    expect(side.map(({ width, height }) => [width, height])).toEqual([[640, 720], [640, 720]]);
    const active = trustedVideoLayoutRects("active-speaker", [camera, screen, secondCamera], 1280, 720, profile, secondCamera.sourceId);
    expect(active[0].sourceId).toBe(secondCamera.sourceId);
    expect(active[0].layer).toBe("primary");
    const grid = trustedVideoLayoutRects("grid", [camera, screen, secondCamera], 1280, 720, profile);
    expect(grid).toHaveLength(3);
    expect(grid.every(({ x, y, width, height }) => x >= 0 && y >= 0 && x + width <= 1280 && y + height <= 720)).toBe(true);
  });

  it("renders waiting/end slates without consuming or inventing a source", () => {
    const profile = TRUSTED_VIDEO_PROFILES.bandwidth;
    expect(trustedVideoLayoutRects("waiting-slate", [camera], 960, 540, profile)).toEqual([]);
    expect(trustedVideoLayoutRects("end-slate", [camera], 960, 540, profile)).toEqual([]);
    expect(() => trustedVideoLayoutRects("unknown" as never, [camera], 960, 540, profile))
      .toThrowError(BroadcastBrowserPortError);
  });
});

describe("TrustedVideoProgramSettingsService", () => {
  it("defaults to a stable 720p program and accepts only closed profiles/layouts", () => {
    const settings = new TrustedVideoProgramSettingsService();
    expect(settings.profile()).toMatchObject({ width: 1280, height: 720, framesPerSecond: 24 });
    expect(settings.layout()).toBe("screen-presenter");
    expect(settings.setProfile("screen-text")).toBe(true);
    expect(settings.setLayout("grid")).toBe(true);
    expect(settings.setProfile("8k")).toBe(false);
    expect(settings.setLayout("remote-html")).toBe(false);
  });

  it("keeps all identifying overlays opt-in and rejects controls", () => {
    const settings = new TrustedVideoProgramSettingsService();
    expect(settings.overlay()).toEqual({
      policyVersion: 1, showSourceLabels: false, showProgramTitle: false,
      showCaptions: false, programTitle: "", captionText: "",
      captionStyle: "high-contrast", captionPositionPercent: 88,
    });
    expect(() => normalizeTrustedVideoOverlay({
      ...settings.overlay(), showProgramTitle: true, programTitle: "bad\nmetadata",
    })).toThrow("invalid_trusted_video_overlay");
  });
});

describe("BrowserTrustedVideoCompositorFactory", () => {
  it("creates one fixed canvas track only after invocation and releases every DOM/media resource", async () => {
    vi.useFakeTimers();
    const outputTrack = Object.assign(new EventTarget(), { kind: "video", readyState: "live", stop: vi.fn(), contentHint: "" });
    const outputStream = { getVideoTracks: () => [outputTrack], getTracks: () => [outputTrack] } as unknown as MediaStream;
    const context = {
      fillStyle: "", font: "", textAlign: "start", textBaseline: "bottom",
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
      configurable: true, value: vi.fn(() => outputStream),
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const inputTrack = Object.assign(new EventTarget(), { kind: "video", readyState: "live" });
    const inputStream = {
      getVideoTracks: () => [inputTrack], getTracks: () => [inputTrack],
    } as unknown as MediaStream;
    const factory = new BrowserTrustedVideoCompositorFactory();
    const handle = await factory.create({
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    }, [{ ...camera, stream: inputStream, label: "Eigene Kamera" }], TRUSTED_VIDEO_PROFILES.balanced,
    "single", {
      policyVersion: 1, showSourceLabels: false, showProgramTitle: false,
      showCaptions: false, programTitle: "", captionText: "",
      captionStyle: "high-contrast", captionPositionPercent: 88,
    }, new AbortController().signal);

    expect(handle.track).toBe(outputTrack);
    expect(handle.snapshot()).toMatchObject({ width: 1280, height: 720, framesRendered: 1, sourceCount: 1 });
    handle.setLayout("waiting-slate");
    await vi.advanceTimersByTimeAsync(50);
    expect(context.fillText).toHaveBeenCalledWith("Sendung beginnt gleich", 640, 360, 1200);
    await handle.close();
    await handle.close();
    expect(outputTrack.stop).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
  });
});

describe("trusted compositor failure boundaries", () => {
  function setup() {
    vi.useFakeTimers();
    const track = () => {
      const value = Object.assign(new EventTarget(), { kind: "video", readyState: "live", stop: vi.fn(), contentHint: "" });
      value.stop.mockImplementation(() => { value.readyState = "ended"; }); return value;
    };
    const input = track(), output = track(), context = { fillStyle: "", font: "", textAlign: "", textBaseline: "",
      fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn() };
    const stream = (tracks: ReturnType<typeof track>[]) => ({ getVideoTracks: () => tracks, getTracks: () => tracks }) as unknown as MediaStream;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const capture = vi.fn(() => stream([output]));
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", { configurable: true, value: capture });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const controller = new AbortController();
    const create = () => new BrowserTrustedVideoCompositorFactory().create({ tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha",
      programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 }, [{ ...camera, stream: stream([input]) }],
      TRUSTED_VIDEO_PROFILES.balanced, "single", new TrustedVideoProgramSettingsService().overlay(), controller.signal);
    return { input, output, context, capture, play, pause, controller, create, stream, track };
  }
  it("bounds stalled playback and never starts output after timeout", async () => {
    const f = setup(); f.play.mockImplementation(() => new Promise(() => {}));
    const pending = expect(f.create()).rejects.toThrow("trusted_video_play_timeout");
    await vi.advanceTimersByTimeAsync(5001); await pending;
    expect(f.capture).not.toHaveBeenCalled(); expect(f.pause).toHaveBeenCalledOnce();
    expect(f.input.stop).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts pending playback immediately and removes its timer and owned video", async () => {
    const f = setup(); f.play.mockImplementation(() => new Promise(() => {}));
    const pending = expect(f.create()).rejects.toThrow(); f.controller.abort(); await pending;
    expect(f.capture).not.toHaveBeenCalled(); expect(f.pause).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops every unexpected output track if canvas capture returns an invalid track set", async () => {
    const f = setup(), extra = f.track(); f.capture.mockReturnValue(f.stream([f.output, extra]));
    await expect(f.create()).rejects.toThrow("trusted_video_output_unavailable");
    expect(f.output.stop).toHaveBeenCalledOnce(); expect(extra.stop).toHaveBeenCalledOnce(); expect(f.input.stop).not.toHaveBeenCalled();
  });
  it("releases canvas output on initial or subsequent renderer failure", async () => {
    const f = setup(); f.context.fillRect.mockImplementationOnce(() => { throw new Error("initial render failed"); });
    await expect(f.create()).rejects.toThrow("initial render failed"); expect(f.output.stop).toHaveBeenCalledOnce();
    const second = setup(), handle = await second.create();
    second.context.fillRect.mockImplementationOnce(() => { throw new Error("runtime render failed"); });
    await vi.advanceTimersByTimeAsync(50);
    expect(handle.snapshot()).toMatchObject({ degradedReason: "render-error", effectiveFramesPerSecond: 0, sourceCount: 0 });
    expect(second.output.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(() => handle.setLayout("single")).toThrow("trusted_video_compositor_closed");
    expect(() => handle.setOverlay(new TrustedVideoProgramSettingsService().overlay())).toThrow("trusted_video_compositor_closed");
    expect(second.input.stop).not.toHaveBeenCalled(); await handle.close(); expect(second.output.stop).toHaveBeenCalledOnce();
  });
  it("detects a locally stopped input even when no ended event is dispatched", async () => {
    const f = setup(), handle = await f.create(); f.input.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(handle.snapshot()).toMatchObject({ sourceCount: 0, degradedReason: "source-ended" });
    expect(f.context.fillText).toHaveBeenCalledWith("Sendung beginnt gleich", 640, 360, 1200);
    f.controller.abort(); expect(f.output.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects unknown overlay authority fields", () => {
    expect(() => normalizeTrustedVideoOverlay({ ...new TrustedVideoProgramSettingsService().overlay(), remoteConsent: true } as never))
      .toThrow("invalid_trusted_video_overlay");
  });
  it("rejects an empty playback rejection and an already ended canvas output", async () => {
    const f = setup(); f.play.mockRejectedValueOnce(undefined);
    await expect(f.create()).rejects.toThrow("trusted_video_play_failed"); expect(f.capture).not.toHaveBeenCalled();
    f.output.readyState = "ended";
    await expect(f.create()).rejects.toThrow("trusted_video_output_unavailable");
    expect(f.input.stop).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
