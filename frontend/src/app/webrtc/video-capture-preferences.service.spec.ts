import { beforeEach, describe, expect, it } from "vitest";

import {
  VIDEO_CAPTURE_STORAGE_KEY,
  VideoCapturePreferencesService,
  appliedVideoSettingsLabel,
  createVideoCaptureConstraints,
  normalizeAppliedVideoSettings,
  parseVideoCapturePreferences,
} from "./video-capture-preferences.service";

describe("VideoCapturePreferencesService", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the established automatic camera and screen capture envelopes", () => {
    const service = new VideoCapturePreferencesService();
    expect(service.constraints("camera")).toEqual({
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 24, max: 30 },
    });
    expect(service.constraints("screen")).toEqual({
      frameRate: { ideal: 15, max: 30 },
    });
    expect(service.screenAudioEnabled()).toBe(false);
  });

  it("builds best-effort ceilings for low-bandwidth resolution and FPS choices", () => {
    expect(createVideoCaptureConstraints("camera", { resolutionId: "360p", frameRate: 5 })).toEqual({
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 360 },
      frameRate: { ideal: 5, max: 5 },
    });
    expect(createVideoCaptureConstraints("screen", { resolutionId: "2160p", frameRate: 60 })).toEqual({
      width: { ideal: 3840, max: 3840 },
      height: { ideal: 2160, max: 2160 },
      frameRate: { ideal: 15, max: 60 },
    });
  });

  it("normalizes unsupported persisted values without affecting the other source", () => {
    localStorage.setItem(VIDEO_CAPTURE_STORAGE_KEY, JSON.stringify({
      version: 1,
      camera: { resolutionId: "8k", frameRate: 7 },
      screen: { resolutionId: "1440p", frameRate: 10 },
    }));
    const service = new VideoCapturePreferencesService();
    expect(service.camera()).toEqual({ resolutionId: "auto", frameRate: 30 });
    expect(service.screen()).toEqual({ resolutionId: "1440p", frameRate: 10 });
    expect(service.screenAudioEnabled()).toBe(false);
    expect(parseVideoCapturePreferences("not-json").camera).toEqual({ resolutionId: "auto", frameRate: 30 });
  });

  it("persists separate choices and reports the actual browser settings", () => {
    const service = new VideoCapturePreferencesService();
    service.setResolution("camera", "240p");
    service.setFrameRate("camera", "2");
    expect(service.camera()).toEqual({ resolutionId: "240p", frameRate: 2 });
    expect(service.screen()).toEqual({ resolutionId: "auto", frameRate: 30 });
    expect(JSON.parse(localStorage.getItem(VIDEO_CAPTURE_STORAGE_KEY) || "{}").camera)
      .toEqual({ resolutionId: "240p", frameRate: 2 });

    service.setScreenAudioEnabled(true);
    expect(service.screenAudioEnabled()).toBe(true);
    expect(JSON.parse(localStorage.getItem(VIDEO_CAPTURE_STORAGE_KEY) || "{}").screenAudioEnabled).toBe(true);
    service.setScreenAudioEnabled("true");
    expect(service.screenAudioEnabled()).toBe(false);

    const applied = normalizeAppliedVideoSettings({ width: 426, height: 240, frameRate: 1.98 });
    expect(applied).toEqual({ width: 426, height: 240, frameRate: 2 });
    expect(appliedVideoSettingsLabel(applied)).toBe("426 × 240 · 2 FPS");
    service.recordApplied("camera", { width: 426, height: 240, frameRate: 2 });
    expect(service.cameraAppliedLabel()).toBe("426 × 240 · 2 FPS");
    service.clearApplied("camera");
    expect(service.cameraAppliedLabel()).toBe("Nicht aktiv");
  });
});
