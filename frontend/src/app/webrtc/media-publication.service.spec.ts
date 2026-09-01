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

function fakeScreenStream() {
  let tracks: Array<Record<string, unknown>> = [];
  const video = {
    kind: "video",
    id: "screen-video-track",
    readyState: "live",
    stop: vi.fn(function stop(this: { readyState: string }) { this.readyState = "ended"; }),
    onended: null,
    getSettings: vi.fn(() => ({ width: 1280, height: 720, frameRate: 15 })),
    applyConstraints: vi.fn(),
  };
  const audio = {
    kind: "audio",
    id: "screen-audio-track",
    readyState: "live",
    stop: vi.fn(function stop(this: { readyState: string }) { this.readyState = "ended"; }),
    onended: null,
    getSettings: vi.fn(() => ({ restrictOwnAudio: true })),
    applyConstraints: vi.fn(),
  };
  tracks = [video, audio];
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
    removeTrack: vi.fn((track: Record<string, unknown>) => { tracks = tracks.filter((item) => item !== track); }),
  } as unknown as MediaStream;
  return { video, audio, stream };
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
      audio: false,
    });
    expect(service.screenAudioActive()).toBe(false);
  });

  it("requests opted-in screen audio with a supported own-audio guard and can stop only that track", async () => {
    const screen = fakeScreenStream();
    const getDisplayMedia = vi.fn().mockResolvedValue(screen.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        getDisplayMedia,
        getSupportedConstraints: () => ({ restrictOwnAudio: true }),
      },
    });
    const mesh = {
      attachPublication: vi.fn(),
      detachPublication: vi.fn(),
      detachPublicationTrack: vi.fn((_source: string, track: Record<string, unknown>) => screen.stream.removeTrack(track as never)),
    };
    const preferences = new VideoCapturePreferencesService();
    preferences.setScreenAudioEnabled(true);
    const service = new MediaPublicationService(mesh as never, preferences);

    expect(getDisplayMedia).not.toHaveBeenCalled();
    await service.toggle("screen");
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: { restrictOwnAudio: true },
    });
    expect(service.screenAudioActive()).toBe(true);

    service.setScreenAudioEnabled(false);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(mesh.detachPublicationTrack).toHaveBeenCalledWith("screen", screen.audio);
    expect(screen.audio.stop).toHaveBeenCalledTimes(1);
    expect(screen.video.stop).not.toHaveBeenCalled();
    expect(screen.stream.getAudioTracks()).toEqual([]);
    expect(service.screenAudioActive()).toBe(false);
    expect(service.active("screen")).toBe(true);
  });

  it("uses a portable boolean audio opt-in when own-audio restriction is unavailable", async () => {
    const screen = fakeScreenStream();
    const getDisplayMedia = vi.fn().mockResolvedValue(screen.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        getDisplayMedia,
        getSupportedConstraints: () => ({}),
      },
    });
    const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
    const preferences = new VideoCapturePreferencesService();
    preferences.setScreenAudioEnabled(true);
    const service = new MediaPublicationService(mesh as never, preferences);

    await service.toggle("screen");
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: true,
    });
    expect(service.screenAudioActive()).toBe(true);
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
