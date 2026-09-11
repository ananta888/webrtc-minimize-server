import { describe, expect, it } from "vitest";
import { computeStageLayout, StageLayoutOptions } from "./stage-layout";
import { LocalMediaView } from "./media-publication.service";
import { RemoteMediaView } from "./peer-mesh.service";

function mockStream(): MediaStream {
  return {
    id: "mock-stream-" + Math.random(),
    getTracks: () => [],
    getVideoTracks: () => [{ kind: "video" } as unknown as MediaStreamTrack],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

describe("computeStageLayout", () => {
  it("returns mode empty when no publications exist", () => {
    const layout = computeStageLayout({
      localPublications: [],
      remoteMedia: [],
      ownPeerId: "local1",
    });
    expect(layout.mode).toBe("empty");
    expect(layout.stageItem).toBeNull();
    expect(layout.filmstripItems).toHaveLength(0);
    expect(layout.allVideoItems).toHaveLength(0);
  });

  it("filters out audio publications and unknown sources", () => {
    const audioPub: LocalMediaView = {
      source: "microphone",
      stream: mockStream(),
      kind: "audio",
    };
    const remoteAudio: RemoteMediaView = {
      key: "rem-audio",
      peerId: "p2",
      peerName: "Alice",
      source: "audio",
      kind: "audio",
      stream: mockStream(),
      transportPeerId: "p2",
    };
    const invalidRemote: any = {
      key: "invalid",
      peerId: "p3",
      source: "custom-unknown",
      kind: "video",
      stream: mockStream(),
    };

    const layout = computeStageLayout({
      localPublications: [audioPub],
      remoteMedia: [remoteAudio, invalidRemote],
      ownPeerId: "local1",
    });
    expect(layout.mode).toBe("empty");
    expect(layout.allVideoItems).toHaveLength(0);
  });

  it("selects grid mode for up to 2 cameras with auto preference and no screen/pin/presenter", () => {
    const localCamera: LocalMediaView = {
      source: "camera",
      stream: mockStream(),
      kind: "video",
    };
    const remoteCamera: RemoteMediaView = {
      key: "rem-cam-1",
      peerId: "p2",
      peerName: "Alice",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "p2",
    };

    const layout = computeStageLayout({
      localPublications: [localCamera],
      remoteMedia: [remoteCamera],
      ownPeerId: "local1",
      preferredView: "auto",
    });
    expect(layout.mode).toBe("grid");
    expect(layout.stageItem).toBeNull();
    expect(layout.allVideoItems).toHaveLength(2);
  });

  it("switches to stage mode screen-first when any screen is shared", () => {
    const localCamera: LocalMediaView = {
      source: "camera",
      stream: mockStream(),
      kind: "video",
    };
    const remoteScreen: RemoteMediaView = {
      key: "rem-screen-1",
      peerId: "p2",
      peerName: "Alice",
      source: "screen",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "p2",
    };

    const layout = computeStageLayout({
      localPublications: [localCamera],
      remoteMedia: [remoteScreen],
      ownPeerId: "local1",
    });
    expect(layout.mode).toBe("stage");
    expect(layout.hasScreenShare).toBe(true);
    expect(layout.stageItem?.id).toBe("rem-screen-1");
    expect(layout.stageItem?.isScreen).toBe(true);
    expect(layout.filmstripItems).toHaveLength(1);
    expect(layout.filmstripItems[0].source).toBe("camera");
  });

  it("prioritizes local pin over screen and presenter", () => {
    const localScreen: LocalMediaView = {
      source: "screen",
      stream: mockStream(),
      kind: "video",
    };
    const remoteCameraBob: RemoteMediaView = {
      key: "bob-cam",
      peerId: "bob",
      peerName: "Bob",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "bob",
    };

    const layout = computeStageLayout({
      localPublications: [localScreen],
      remoteMedia: [remoteCameraBob],
      ownPeerId: "local1",
      presenterPeerId: "local1",
      localPinPeerId: "bob", // User pinned Bob
    });

    expect(layout.mode).toBe("stage");
    expect(layout.stageItem?.peerId).toBe("bob");
    expect(layout.stageItem?.isPinned).toBe(true);
    // Screen is in filmstrip
    expect(layout.filmstripItems[0].isScreen).toBe(true);
  });

  it("prioritizes presenter camera over non-presenter camera when no pin and no screen", () => {
    const camAlice: RemoteMediaView = {
      key: "alice-cam",
      peerId: "alice",
      peerName: "Alice",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "alice",
    };
    const camBobPresenter: RemoteMediaView = {
      key: "bob-cam",
      peerId: "bob",
      peerName: "Bob",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "bob",
    };
    const camCarol: RemoteMediaView = {
      key: "carol-cam",
      peerId: "carol",
      peerName: "Carol",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "carol",
    };

    const layout = computeStageLayout({
      localPublications: [],
      remoteMedia: [camAlice, camBobPresenter, camCarol],
      ownPeerId: "local1",
      presenterPeerId: "bob",
    });

    expect(layout.mode).toBe("stage");
    expect(layout.stageItem?.peerId).toBe("bob");
    expect(layout.stageItem?.isPresenter).toBe(true);
    expect(layout.filmstripItems).toHaveLength(2);
    expect(layout.filmstripItems.map(i => i.peerId)).toEqual(["alice", "carol"]);
  });

  it("prioritizes active speaker when no pin, screen or presenter", () => {
    const camAlice: RemoteMediaView = {
      key: "alice-cam",
      peerId: "alice",
      peerName: "Alice",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "alice",
    };
    const camBob: RemoteMediaView = {
      key: "bob-cam",
      peerId: "bob",
      peerName: "Bob",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "bob",
    };
    const camCarol: RemoteMediaView = {
      key: "carol-cam",
      peerId: "carol",
      peerName: "Carol",
      source: "camera",
      kind: "video",
      stream: mockStream(),
      transportPeerId: "carol",
    };

    const layout = computeStageLayout({
      localPublications: [],
      remoteMedia: [camAlice, camBob, camCarol],
      ownPeerId: "local1",
      activeSpeakerIds: ["carol"],
      preferredView: "stage",
    });

    expect(layout.mode).toBe("stage");
    expect(layout.stageItem?.peerId).toBe("carol");
  });
});
