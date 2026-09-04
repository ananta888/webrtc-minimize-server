import { beforeEach, describe, expect, it, vi } from "vitest";

import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import { BroadcastOwnSourceCompositionService } from "./broadcast-own-source-composition.service";
import { BroadcastCaptureForkHandle } from "./broadcast-ports";
import {
  TrustedAudioProgramBusFactory,
  TrustedAudioProgramSettingsService,
} from "./trusted-audio-program-bus";

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

function service(capture: BroadcastOwnSourceCaptureService, factory = audioFactory()) {
  return new BroadcastOwnSourceCompositionService(
    capture,
    factory,
    new TrustedAudioProgramSettingsService(),
  );
}

describe("BroadcastOwnSourceCompositionService", () => {
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
      { sourceId: camera.sourceId, sourceKind: "camera", envelope: "clear-program-v1", kind: "video" },
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

  it("requires a later compositor for two same-kind inputs and keeps release idempotent", async () => {
    const capture = { stream: vi.fn(() => source("video")) } as unknown as BroadcastOwnSourceCaptureService;
    const composition = service(capture);
    const signal = new AbortController().signal;
    const forks = [fork("camera", "camera"), fork("screen", "screen")];
    await expect(composition.compose({
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    }, forks, consent(forks), signal))
      .rejects.toThrow("broadcast_composition_required");
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
});
