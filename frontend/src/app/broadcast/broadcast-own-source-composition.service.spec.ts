import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import { BroadcastOwnSourceCompositionService } from "./broadcast-own-source-composition.service";
import { BroadcastCaptureForkHandle } from "./broadcast-ports";
import {
  TrustedAudioProgramBusFactory,
  TrustedAudioProgramSettingsService,
} from "./trusted-audio-program-bus";
import {
  TrustedVideoCompositorFactory,
  TrustedVideoProgramSettingsService,
} from "./trusted-video-compositor";

function fork(id: string, kind: "camera" | "microphone" | "screen" | "screen-audio"): BroadcastCaptureForkHandle {
  return { forkId: `fork_${id.padEnd(16, "a")}`, sourceId: `src_${id.padEnd(16, "a")}`, kind };
}

function source(kind: "audio" | "video"): MediaStream {
  const track = Object.assign(new EventTarget(), { kind, readyState: "live", contentHint: "" });
  return {
    getTracks: () => [track as MediaStreamTrack],
    getAudioTracks: () => kind === "audio" ? [track as MediaStreamTrack] : [],
  } as unknown as MediaStream;
}

function consent(forks: readonly BroadcastCaptureForkHandle[]) {
  return {
    decisionVersion: 1 as const,
    programEpoch: 1,
    sourceIds: forks.map(({ sourceId }) => sourceId),
    expiresAt: Date.now() + 60_000,
  };
}

function audioFactory(): TrustedAudioProgramBusFactory {
  return {
    supported: true,
    async create(_program, inputs) {
      const stream = source("audio");
      return {
        outputSourceId: "src_programaudioaaaa",
        stream,
        track: stream.getTracks()[0],
        snapshot: () => ({
          profileId: "speech", monitoringMode: "off", sampleRate: 48_000, channelCount: 1,
          opusBitsPerSecond: 64_000, aacBitsPerSecond: 96_000, dtxRequested: true,
          fecRequested: true, sourceLevels: Object.fromEntries(inputs.map(({ sourceId }) => [sourceId, 0])),
          peakLevel: 0,
        }),
        setSourceMuted() {}, setSourceGain() {}, async close() {},
      };
    },
  };
}

function videoFactory(close = vi.fn(async () => {})): TrustedVideoCompositorFactory {
  return {
    supported: true,
    async create(_program, inputs) {
      const stream = source("video");
      return {
        outputSourceId: "src_programvideoaaaa",
        stream,
        track: stream.getTracks()[0],
        snapshot: () => ({
          layout: "screen-presenter", profileId: "balanced", width: 1280, height: 720,
          targetFramesPerSecond: 24, effectiveFramesPerSecond: 24,
          framesRendered: 1, framesSkipped: 0, sourceCount: inputs.length, degradedReason: "none",
        }),
        setLayout() {}, setOverlay() {}, close,
      };
    },
  };
}

function service(
  capture: BroadcastOwnSourceCaptureService,
  factory = audioFactory(),
  compositor = videoFactory(),
) {
  return new BroadcastOwnSourceCompositionService(
    capture,
    factory,
    new TrustedAudioProgramSettingsService(),
    compositor,
    new TrustedVideoProgramSettingsService(),
  );
}

describe("BroadcastOwnSourceCompositionService", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.stubGlobal("MediaStream", class {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() { return this.tracks; }
    });
  });

  it("resolves one audio and one video fork as a single WHIP MediaStream without stopping either track", async () => {
    const camera = fork("camera", "camera");
    const microphone = fork("microphone", "microphone");
    const capture = {
      stream: vi.fn((handle: BroadcastCaptureForkHandle) => handle.kind === "camera" ? source("video") : source("audio")),
    } as unknown as BroadcastOwnSourceCaptureService;
    const composition = service(capture);
    const signal = new AbortController().signal;
    const forks = [camera, microphone];
    const handle = await composition.compose({
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    }, forks, consent(forks), signal);
    const media = await composition.resolve(handle, signal);
    expect(media.stream.getTracks().map(({ kind }) => kind)).toEqual(["video", "audio"]);
    expect(media.tracks.map(({ sourceId, sourceKind, envelope, track }) => ({
      sourceId, sourceKind, envelope, kind: track.kind,
    }))).toEqual([
      { sourceId: "src_programvideoaaaa", sourceKind: "program-video", envelope: "clear-program-v1", kind: "video" },
      {
        sourceId: "src_programaudioaaaa",
        sourceKind: "program-audio",
        envelope: "clear-program-v1",
        kind: "audio",
      },
    ]);
    await composition.release(handle);
    await expect(composition.resolve(handle, signal)).rejects.toThrow("unknown_broadcast_composition");
  });

  it("composes screen plus presenter into one stable video output and closes it", async () => {
    const capture = { stream: vi.fn(() => source("video")) } as unknown as BroadcastOwnSourceCaptureService;
    const close = vi.fn(async () => {});
    const factory = videoFactory(close);
    const composition = service(capture, audioFactory(), factory);
    const signal = new AbortController().signal;
    const forks = [fork("camera", "camera"), fork("screen", "screen")];
    const handle = await composition.compose({
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    }, forks, consent(forks), signal);
    const media = await composition.resolve(handle, signal);
    expect(media.tracks).toHaveLength(1);
    expect(media.tracks[0].sourceKind).toBe("program-video");
    expect(factory.create).toBeTypeOf("function");
    await composition.release(handle);
    expect(close).toHaveBeenCalledOnce();
    await composition.release({ compositionId: "missing-composition", sourceIds: [] });
  });

  it("mixes microphone and screen audio only with an exact current consent and closes the bus", async () => {
    const microphone = fork("microphone", "microphone");
    const screenAudio = fork("screenaudio", "screen-audio");
    const streams = new Map([
      [microphone.forkId, source("audio")],
      [screenAudio.forkId, source("audio")],
    ]);
    const capture = {
      stream: vi.fn((handle: BroadcastCaptureForkHandle) => streams.get(handle.forkId)),
    } as unknown as BroadcastOwnSourceCaptureService;
    const close = vi.fn(async () => {});
    const factory = audioFactory();
    vi.spyOn(factory, "create").mockImplementation(async (_program, inputs) => {
      const created = await audioFactory().create(_program, inputs, {} as never, "off", new AbortController().signal);
      return { ...created, close };
    });
    const composition = service(capture, factory);
    const program = {
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    };
    const forks = [microphone, screenAudio];

    await expect(composition.compose(program, forks, {
      ...consent(forks), sourceIds: [microphone.sourceId],
    }, new AbortController().signal)).rejects.toThrow("invalid_broadcast_composition_sources");
    const handle = await composition.compose(program, forks, consent(forks), new AbortController().signal);
    expect(factory.create).toHaveBeenCalledOnce();
    const media = await composition.resolve(handle, new AbortController().signal);
    expect(media.tracks).toHaveLength(1);
    expect(media.tracks[0].sourceKind).toBe("program-audio");
    await composition.release(handle);
    expect(close).toHaveBeenCalledOnce();
  });

  for (const scenario of ["destroy", "abort", "expired-consent", "video-failure"]) it(`closes partial asynchronous composition on ${scenario} without regaining ownership`, async () => {
    const capture = { stream: (handle: BroadcastCaptureForkHandle) => source(handle.kind === "microphone" ? "audio" : "video") } as BroadcastOwnSourceCaptureService;
    const audio = audioFactory(), audioClose = vi.fn(async () => {}), videoClose = vi.fn(async () => {});
    const originalAudio = audio.create.bind(audio);
    vi.spyOn(audio, "create").mockImplementation(async (...args) => ({ ...await originalAudio(...args), close: audioClose }));
    const video = videoFactory(videoClose), originalVideo = video.create.bind(video);
    let complete!: () => Promise<void>, fail!: (reason: Error) => void;
    vi.spyOn(video, "create").mockImplementation((...args) => new Promise((resolve, reject) => {
      complete = async () => resolve(await originalVideo(...args)); fail = reject;
    }));
    const composition = service(capture, audio, video), controller = new AbortController();
    const forks = [fork("microphone", "microphone"), fork("camera", "camera")], grant = consent(forks);
    const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 };
    const pending = composition.compose(program, forks, grant, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    if (scenario === "destroy") composition.ngOnDestroy();
    if (scenario === "abort") controller.abort();
    if (scenario === "expired-consent") {
      const expiresAt = grant.expiresAt; grant.expiresAt += 3_600_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
      await complete(); await rejected; now.mockRestore();
    }
    if (scenario === "video-failure") fail(new Error("synthetic video failure"));
    await rejected;
    if (scenario === "destroy" || scenario === "abort") await complete();
    await vi.waitFor(() => expect(audioClose).toHaveBeenCalledOnce());
    if (scenario !== "video-failure") await vi.waitFor(() => expect(videoClose).toHaveBeenCalledOnce());
    composition.ngOnDestroy(); expect(audioClose).toHaveBeenCalledOnce();
  });

  it("revokes composition access on external abort and rejects forged caption handles", async () => {
    const capture = { stream: () => source("video") } as unknown as BroadcastOwnSourceCaptureService;
    const video = videoFactory(), original = video.create.bind(video), overlay = vi.fn();
    vi.spyOn(video, "create").mockImplementation(async (...args) => ({ ...await original(...args), setOverlay: overlay }));
    const composition = service(capture, audioFactory(), video), controller = new AbortController(), forks = [fork("camera", "camera")];
    const handle = await composition.compose({ tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1 }, forks, consent(forks), controller.signal);
    expect(composition.setCaptionOverlay({ ...handle, sourceIds: [] }, "synthetic", "large", 88)).toBe(false);
    expect(overlay).not.toHaveBeenCalled();
    expect(composition.setCaptionOverlay(handle, "synthetic", "large", 88)).toBe(true);
    controller.abort();
    await expect(composition.resolve(handle, new AbortController().signal)).rejects.toThrow("unknown_broadcast_composition");
    expect(composition.setCaptionOverlay(handle, "synthetic", "large", 88)).toBe(false);
  });

  it("retains failed cleanup only for retry, never for media or captions", async () => {
    const capture = { stream: () => source("video") } as unknown as BroadcastOwnSourceCaptureService;
    const close = vi.fn(async () => {}); close.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    const composition = service(capture, audioFactory(), videoFactory(close)), forks = [fork("camera", "camera")];
    const handle = await composition.compose({ tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1 }, forks, consent(forks), new AbortController().signal);
    await expect(composition.release(handle)).rejects.toThrow("broadcast_composition_cleanup_failed");
    await expect(composition.resolve(handle, new AbortController().signal)).rejects.toThrow("unknown_broadcast_composition");
    expect(composition.setCaptionOverlay(handle, "synthetic", "large", 88)).toBe(false);
    await composition.release(handle); await composition.release(handle); expect(close).toHaveBeenCalledTimes(2);
  });
});
