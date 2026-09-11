import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { signal } from "@angular/core";
import { PresentationStageService } from "./presentation-stage.service";
import { LocalMediaView } from "./media-publication.service";
import { RemoteMediaView } from "./peer-mesh.service";

function mockStream(): MediaStream {
  return {
    id: "mock-stream",
    getTracks: () => [],
    getVideoTracks: () => [{ kind: "video" } as unknown as MediaStreamTrack],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

describe("PresentationStageService", () => {
  function createService() {
    const publications = signal<readonly LocalMediaView[]>([]);
    const remoteMedia = signal<readonly RemoteMediaView[]>([]);
    const presenterPeerId = signal<string>("");
    const peerId = signal<string>("local1");
    const displayName = signal<string>("Local User");
    const activeSpeakerIds = signal<readonly string[]>([]);

    const media = { publications } as any;
    const mesh = { remoteMedia, activeSpeakerIds } as any;
    const moderation = { presenterPeerId } as any;
    const session = { peerId, displayName } as any;

    const service = new PresentationStageService(media, mesh, moderation, session);
    return { service, publications, remoteMedia, presenterPeerId, peerId, activeSpeakerIds };
  }

  it("toggles and clears local pin correctly", () => {
    const { service } = createService();
    expect(service.localPin()).toBe("");

    service.togglePin("peerA");
    expect(service.localPin()).toBe("peerA");

    // Toggle same peer clears pin
    service.togglePin("peerA");
    expect(service.localPin()).toBe("");

    // Toggle another peer sets new pin
    service.togglePin("peerB");
    expect(service.localPin()).toBe("peerB");

    service.clearPin();
    expect(service.localPin()).toBe("");
  });

  it("computes stage layout reactively when publications update", () => {
    const { service, publications, remoteMedia } = createService();
    expect(service.mode()).toBe("empty");

    publications.set([
      { source: "camera", stream: mockStream(), kind: "video" },
    ]);
    expect(service.allVideoItems()).toHaveLength(1);

    remoteMedia.set([
      {
        key: "rem1",
        peerId: "remote1",
        peerName: "Alice",
        source: "screen",
        kind: "video",
        stream: mockStream(),
        transportPeerId: "remote1",
      },
    ]);

    expect(service.hasScreenShare()).toBe(true);
    expect(service.mode()).toBe("stage");
    expect(service.stageItem()?.isScreen).toBe(true);
    expect(service.stageItem()?.peerId).toBe("remote1");
    expect(service.filmstripItems()).toHaveLength(1);
    expect(service.filmstripItems()[0].isLocal).toBe(true);
  });

  it("resets state completely on reset()", () => {
    const { service } = createService();
    service.togglePin("peerA");
    service.setViewPreference("grid");
    service.setFullscreen(true);

    service.reset();
    expect(service.localPin()).toBe("");
    expect(service.viewPreference()).toBe("auto");
    expect(service.isFullscreen()).toBe(false);
  });

  it("contains no capture APIs", () => {
    const source = readFileSync("frontend/src/app/webrtc/presentation-stage.service.ts", "utf8");
    expect(source).not.toContain("getUserMedia");
    expect(source).not.toContain("getDisplayMedia");
  });
});
