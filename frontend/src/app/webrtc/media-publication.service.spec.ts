import { describe, expect, it, vi } from "vitest";

import { MediaPublicationService } from "./media-publication.service";

function fakeStream(kind: "audio" | "video") {
  const track = { kind, id: `${kind}-track`, stop: vi.fn(), onended: null };
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
  it("does not request capture until the explicit source action", async () => {
    const audio = fakeStream("audio");
    const getUserMedia = vi.fn().mockResolvedValue(audio.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getDisplayMedia: vi.fn() },
    });
    const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
    const service = new MediaPublicationService(mesh as never);
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
    const service = new MediaPublicationService(mesh as never);
    await service.toggle("screen");
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: true,
    });
  });
});
