import { beforeEach, describe, expect, it, vi } from "vitest";

import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import { BroadcastOwnSourceCompositionService } from "./broadcast-own-source-composition.service";
import { BroadcastCaptureForkHandle } from "./broadcast-ports";

function fork(id: string, kind: "camera" | "microphone" | "screen" | "screen-audio"): BroadcastCaptureForkHandle {
  return { forkId: `fork_${id.padEnd(16, "a")}`, sourceId: `src_${id.padEnd(16, "a")}`, kind };
}

function source(kind: "audio" | "video"): MediaStream {
  return {
    getTracks: () => [{ kind, readyState: "live" } as MediaStreamTrack],
  } as unknown as MediaStream;
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
    const composition = new BroadcastOwnSourceCompositionService(capture);
    const signal = new AbortController().signal;
    const handle = await composition.compose({
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    }, [camera, microphone], signal);
    expect((await composition.resolve(handle, signal)).getTracks().map(({ kind }) => kind)).toEqual(["video", "audio"]);
    await composition.release(handle);
    await expect(composition.resolve(handle, signal)).rejects.toThrow("unknown_broadcast_composition");
  });

  it("requires a later compositor for two same-kind inputs and keeps release idempotent", async () => {
    const capture = { stream: vi.fn(() => source("video")) } as unknown as BroadcastOwnSourceCaptureService;
    const composition = new BroadcastOwnSourceCompositionService(capture);
    const signal = new AbortController().signal;
    await expect(composition.compose({
      tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1, programEpoch: 1,
    }, [fork("camera", "camera"), fork("screen", "screen")], signal))
      .rejects.toThrow("broadcast_composition_required");
    await composition.release({ compositionId: "missing-composition", sourceIds: [] });
  });
});
