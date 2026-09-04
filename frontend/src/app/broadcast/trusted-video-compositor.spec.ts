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
