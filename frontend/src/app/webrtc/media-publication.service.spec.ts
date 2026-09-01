import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPublicationService } from "./media-publication.service";
import { VideoCapturePreferencesService } from "./video-capture-preferences.service";

function fakeStream(kind: "audio" | "video") {
  let settings: MediaTrackSettings = kind === "video"
    ? { width: 1280, height: 720, frameRate: 24 }
    : {};
  const track = {
    kind,
    id: `${kind}-track`,
    stop: vi.fn(),
    onended: null,
    getSettings: vi.fn(() => settings),
    applyConstraints: vi.fn(async (constraints: MediaTrackConstraints) => {
      const width = typeof constraints.width === "object" ? constraints.width.max : undefined;
      const height = typeof constraints.height === "object" ? constraints.height.max : undefined;
      const frameRate = typeof constraints.frameRate === "object" ? constraints.frameRate.max : undefined;
      settings = {
        width: typeof width === "number" ? width : settings.width,
        height: typeof height === "number" ? height : settings.height,
        frameRate: typeof frameRate === "number" ? frameRate : settings.frameRate,
      };
    }),
  };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => kind === "audio" ? [track] : [],
      getVideoTracks: () => kind === "video" ? [track] : [],
    } as unknown as MediaStream,
  };
}

describe("MediaPublicationService", () => {
  beforeEach(() => localStorage.clear());

  it("does not request capture until the explicit source action", async () => {
    const audio = fakeStream("audio");
    const getUserMedia = vi.fn().mockResolvedValue(audio.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getDisplayMedia: vi.fn() },
    });
    const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
    const service = new MediaPublicationService(mesh as never, new VideoCapturePreferencesService());
    expect(getUserMedia).not.toHaveBeenCalled();
    await service.toggle("microphone");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(mesh.attachPublication).toHaveBeenCalledWith("microphone", audio.stream);
    service.stopAll();
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
  });

  it("requests display capture separately and includes browser-provided audio", async () => {
    const video = fakeStream("video");
    const getDisplayMedia = vi.fn().mockResolvedValue(video.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(), getDisplayMedia },
    });
    const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
    const service = new MediaPublicationService(mesh as never, new VideoCapturePreferencesService());
    await service.toggle("screen");
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: true,
    });
  });

  it("applies changed camera ceilings to the active track without another capture", async () => {
    const video = fakeStream("video");
    const getUserMedia = vi.fn().mockResolvedValue(video.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getDisplayMedia: vi.fn() },
    });
    const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
    const preferences = new VideoCapturePreferencesService();
    preferences.setResolution("camera", "360p");
    preferences.setFrameRate("camera", 5);
    const service = new MediaPublicationService(mesh as never, preferences);

    expect(getUserMedia).not.toHaveBeenCalled();
    await service.toggle("camera");
    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 640, max: 640 },
        height: { ideal: 360, max: 360 },
        frameRate: { ideal: 5, max: 5 },
      },
      audio: false,
    });
    expect(preferences.cameraAppliedLabel()).toBe("1280 × 720 · 24 FPS");

    await service.setVideoResolution("camera", "240p");
    await service.setVideoFrameRate("camera", 2);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(video.track.applyConstraints).toHaveBeenLastCalledWith({
      width: { ideal: 426, max: 426 },
      height: { ideal: 240, max: 240 },
      frameRate: { ideal: 2, max: 2 },
    });
    expect(preferences.cameraAppliedLabel()).toBe("426 × 240 · 2 FPS");
    service.stop("camera");
    expect(preferences.cameraAppliedLabel()).toBe("Nicht aktiv");
  });
});
