import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { MediaStrategyService } from "../webrtc/media-strategy.service";
import { VideoCapturePreferencesService } from "../webrtc/video-capture-preferences.service";
import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import { BroadcastProgramRef, BroadcastRoomSourceRef } from "./broadcast-ports";

let cloneSequence = 0;

function fakeTrack(kind: "audio" | "video", id: string): MediaStreamTrack & { stop: ReturnType<typeof vi.fn> } {
  let state: MediaStreamTrackState = "live";
  const track = {
    kind,
    id,
    enabled: true,
    muted: false,
    onended: null,
    get readyState() { return state; },
    stop: vi.fn(() => { state = "ended"; }),
    clone: vi.fn(() => fakeTrack(kind, `${id}-clone-${++cloneSequence}`)),
    getSettings: vi.fn(() => kind === "video"
      ? { width: 1280, height: 720, frameRate: 24 }
      : { sampleRate: 48_000, channelCount: 1 }),
    applyConstraints: vi.fn(async () => undefined),
  };
  return track as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

class FakeMediaStream {
  constructor(private tracks: MediaStreamTrack[]) {}
  getTracks(): MediaStreamTrack[] { return [...this.tracks]; }
  getAudioTracks(): MediaStreamTrack[] { return this.tracks.filter(({ kind }) => kind === "audio"); }
  getVideoTracks(): MediaStreamTrack[] { return this.tracks.filter(({ kind }) => kind === "video"); }
  removeTrack(track: MediaStreamTrack): void { this.tracks = this.tracks.filter((item) => item !== track); }
}

function program(): BroadcastProgramRef {
  return {
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    programId: "prg_aaaaaaaaaaaaaaaa",
    programRevision: 1,
    programEpoch: 1,
  };
}

function fixture(kind: "audio" | "video") {
  const original = fakeTrack(kind, `${kind}-original`);
  const stream = new FakeMediaStream([original]) as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, getDisplayMedia: vi.fn() },
  });
  const mesh = {
    attachPublication: vi.fn(),
    detachPublication: vi.fn(),
    detachPublicationTrack: vi.fn(),
    refreshMediaStrategy: vi.fn(),
  };
  const media = new MediaPublicationService(
    mesh as never,
    new VideoCapturePreferencesService(),
    new MediaStrategyService(),
  );
  const capture = new BroadcastOwnSourceCaptureService(media);
  return { original, getUserMedia, media, capture };
}

describe("BroadcastOwnSourceCaptureService", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    cloneSequence = 0;
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("clones only a revision-bound locally owned original after explicit room capture", async () => {
    const context = fixture("audio");
    expect(context.getUserMedia).not.toHaveBeenCalled();
    expect(context.capture.activeForks()).toEqual([]);

    await context.media.start("microphone");
    const source = context.media.localOriginalSources()[0];
    expect(source.source).toBe("microphone");
    expect(source.sourceId).toMatch(/^src_[a-f0-9]{32}$/);
    const revision = context.media.localPublicationRevision();

    const remote: BroadcastRoomSourceRef = {
      sourceId: source.sourceId,
      ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa",
      kind: "microphone",
      local: false,
      active: true,
    };
    await expect(context.capture.fork(
      program(), remote, revision, new AbortController().signal,
    )).rejects.toThrow("broadcast_source_not_locally_owned");
    await expect(context.capture.forkForPreview(
      source.sourceId, revision - 1, new AbortController().signal,
    )).rejects.toThrow("stale_local_publication_revision");

    const fork = await context.capture.forkForPreview(
      source.sourceId, revision, new AbortController().signal,
    );
    const clone = fork.stream.getAudioTracks()[0] as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
    expect(clone).not.toBe(context.original);
    expect(context.original.stop).not.toHaveBeenCalled();
    expect(context.capture.stream(fork)).toBe(fork.stream);

    await context.capture.release(fork);
    await context.capture.release(fork);
    expect(clone.stop).toHaveBeenCalledOnce();
    expect(context.original.stop).not.toHaveBeenCalled();
    expect(context.capture.activeForks()).toEqual([]);
  });

  it("stops every clone when its original source ends without double-stopping the original", async () => {
    const context = fixture("video");
    await context.media.start("camera");
    const source = context.media.localOriginalSources()[0];
    const first = await context.capture.forkForPreview(
      source.sourceId,
      context.media.localPublicationRevision(),
      new AbortController().signal,
    );
    const second = await context.capture.forkForPreview(
      source.sourceId,
      context.media.localPublicationRevision(),
      new AbortController().signal,
    );
    const clones = [first.stream.getVideoTracks()[0], second.stream.getVideoTracks()[0]] as Array<
      MediaStreamTrack & { stop: ReturnType<typeof vi.fn> }
    >;

    context.media.stop("camera");
    expect(context.original.stop).toHaveBeenCalledOnce();
    expect(clones.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
    expect(context.capture.activeForks()).toEqual([]);
    expect(context.media.localOriginalSources()).toEqual([]);
  });

  it("cleans a late clone when the caller aborts and never returns it as active", async () => {
    const context = fixture("audio");
    await context.media.start("microphone");
    const source = context.media.localOriginalSources()[0];
    const controller = new AbortController();
    controller.abort();

    await expect(context.capture.forkForPreview(
      source.sourceId,
      context.media.localPublicationRevision(),
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(context.capture.activeForks()).toEqual([]);
    expect(context.original.clone).not.toHaveBeenCalled();
  });
});
