import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { MediaStrategyService } from "../webrtc/media-strategy.service";
import { VideoCapturePreferencesService } from "../webrtc/video-capture-preferences.service";
import { BroadcastAudioMeterFactory } from "./broadcast-audio-meter";
import { BroadcastOwnSourceCaptureService } from "./broadcast-own-source-capture.service";
import { BroadcastOwnSourcePreflightService } from "./broadcast-own-source-preflight.service";
import {
  TrustedAudioProgramBusFactory,
  TrustedAudioProgramSettingsService,
} from "./trusted-audio-program-bus";

let sequence = 0;

function track(kind: "audio" | "video", id: string): MediaStreamTrack & {
  clone: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  let state: MediaStreamTrackState = "live";
  const value = {
    kind,
    id,
    onended: null,
    get readyState() { return state; },
    stop: vi.fn(() => { state = "ended"; }),
    clone: vi.fn(() => track(kind, `${id}-clone-${++sequence}`)),
    getSettings: vi.fn(() => kind === "video"
      ? { width: 1280, height: 720, frameRate: 24 }
      : { sampleRate: 48_000, channelCount: 1 }),
    applyConstraints: vi.fn(async () => undefined),
  };
  return value as unknown as MediaStreamTrack & {
    clone: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

class FakeMediaStream {
  constructor(private tracks: MediaStreamTrack[]) {}
  getTracks(): MediaStreamTrack[] { return [...this.tracks]; }
  getAudioTracks(): MediaStreamTrack[] { return this.tracks.filter(({ kind }) => kind === "audio"); }
  getVideoTracks(): MediaStreamTrack[] { return this.tracks.filter(({ kind }) => kind === "video"); }
  removeTrack(item: MediaStreamTrack): void { this.tracks = this.tracks.filter((track) => track !== item); }
}

function fixture(options: { failMeterCloseOnce?: boolean } = {}) {
  const microphone = track("audio", "microphone-original");
  const camera = track("video", "camera-original");
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => (
    constraints.audio
      ? new FakeMediaStream([microphone])
      : new FakeMediaStream([camera])
  ));
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
  const closedMeters: string[] = [];
  let failMeterClose = options.failMeterCloseOnce === true;
  const meterFactory: BroadcastAudioMeterFactory = {
    supported: true,
    create: vi.fn(async (stream, listener) => {
      const trackId = stream.getTracks()[0].id;
      listener(0.42);
      return {
        async close() {
          if (failMeterClose) {
            failMeterClose = false;
            throw new Error("audio_meter_close_failed");
          }
          closedMeters.push(trackId);
        },
      };
    }),
  };
  const closedProgramAudio: string[] = [];
  const programAudioFactory: TrustedAudioProgramBusFactory = {
    supported: true,
    create: vi.fn(async (_program, inputs, profile, monitoringMode) => {
      const output = track("audio", "program-output");
      return {
        outputSourceId: "src_programaudioaaaa",
        stream: new FakeMediaStream([output]) as unknown as MediaStream,
        track: output,
        snapshot: () => ({
          profileId: profile.profileId,
          monitoringMode,
          sampleRate: 48_000,
          channelCount: profile.channelCount,
          opusBitsPerSecond: profile.opusBitsPerSecond,
          aacBitsPerSecond: profile.aacBitsPerSecond,
          dtxRequested: profile.dtx,
          fecRequested: profile.fec,
          sourceLevels: Object.fromEntries(inputs.map(({ sourceId }) => [sourceId, 0.25])),
          peakLevel: 0.25,
        }),
        setSourceMuted() {},
        setSourceGain() {},
        async close() { output.stop(); closedProgramAudio.push(output.id); },
      };
    }),
  };
  const preflight = new BroadcastOwnSourcePreflightService(
    media,
    capture,
    meterFactory,
    programAudioFactory,
    new TrustedAudioProgramSettingsService(),
  );
  return {
    microphone, camera, getUserMedia, media, capture, meterFactory, closedMeters,
    closedProgramAudio, programAudioFactory, preflight,
  };
}

describe("BroadcastOwnSourcePreflightService", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sequence = 0;
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("never captures from constructor, panel, deep-link state, visibility or source selection", async () => {
    sessionStorage.setItem("broadcast-autostart", "true");
    const context = fixture();
    context.preflight.setPanelVisible(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(context.getUserMedia).not.toHaveBeenCalled();
    expect(context.preflight.selectedSourceIds()).toEqual([]);

    await context.media.start("microphone");
    const source = context.media.localOriginalSources()[0];
    context.preflight.setSourceSelected(source.sourceId, true);
    expect(context.getUserMedia).toHaveBeenCalledOnce();
    expect(context.microphone.clone).not.toHaveBeenCalled();
    await expect(context.preflight.preparePreview("remote-signal")).rejects.toThrow(
      "explicit_broadcast_preview_required",
    );
    expect(context.microphone.clone).not.toHaveBeenCalled();
  });

  it("shows a bounded preflight estimate and creates preview-only clones on the explicit action", async () => {
    const context = fixture();
    await context.media.start("microphone");
    await context.media.start("camera");
    for (const source of context.media.localOriginalSources()) {
      expect(context.preflight.setSourceSelected(source.sourceId, true)).toBe(true);
    }
    context.preflight.setAudience("public");
    context.preflight.setIncludeCaptions(true);

    expect(context.preflight.estimatedUploadBitsPerSecond()).toBeGreaterThan(1_000_000);
    expect(context.preflight.codecProfile()).toContain("WHIP-/Ausgabe-Codec noch nicht ausgehandelt");
    await context.preflight.preparePreview("user-action");
    expect(context.preflight.lifecycle()).toBe("ready");
    expect(context.preflight.previews()).toHaveLength(2);
    expect(context.capture.activeForks()).toHaveLength(2);
    expect(context.meterFactory.create).toHaveBeenCalledOnce();
    expect(context.programAudioFactory.create).toHaveBeenCalledOnce();
    expect(context.preflight.programAudio()).toMatchObject({ profileId: "speech", peakLevel: 0.25 });
    expect(Object.values(context.preflight.audioLevels())).toContain(0.42);
    expect(context.microphone.stop).not.toHaveBeenCalled();
    expect(context.camera.stop).not.toHaveBeenCalled();

    const clones = context.preflight.previews().flatMap(({ stream }) => stream.getTracks()) as Array<
      MediaStreamTrack & { stop: ReturnType<typeof vi.fn> }
    >;
    await context.preflight.stopPreview();
    expect(clones.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
    expect(context.closedMeters).toHaveLength(1);
    expect(context.closedProgramAudio).toEqual(["program-output"]);
    expect(context.microphone.stop).not.toHaveBeenCalled();
    expect(context.camera.stop).not.toHaveBeenCalled();
    expect(context.preflight.lifecycle()).toBe("idle");
  });

  it("cleans clones, meters and selection on source end and session reset", async () => {
    const context = fixture();
    await context.media.start("microphone");
    const source = context.media.localOriginalSources()[0];
    context.preflight.setSourceSelected(source.sourceId, true);
    await context.preflight.preparePreview("user-action");
    const clone = context.preflight.previews()[0].stream.getAudioTracks()[0] as MediaStreamTrack & {
      stop: ReturnType<typeof vi.fn>;
    };

    context.media.stop("microphone");
    await context.preflight.stopPreview("source-ended-test");
    expect(clone.stop).toHaveBeenCalledOnce();
    expect(context.closedMeters).toHaveLength(1);
    expect(context.preflight.selectedSourceIds()).toEqual([]);
    expect(context.preflight.previews()).toEqual([]);
    expect(context.capture.activeForks()).toEqual([]);

    await context.preflight.resetForSession();
    expect(context.preflight.includeCaptions()).toBe(false);
    expect(context.preflight.panelVisible()).toBe(false);
  });

  it("retains failed cleanup resources for a bounded explicit retry", async () => {
    const context = fixture({ failMeterCloseOnce: true });
    await context.media.start("microphone");
    const source = context.media.localOriginalSources()[0];
    context.preflight.setSourceSelected(source.sourceId, true);
    await context.preflight.preparePreview("user-action");

    await expect(context.preflight.stopPreview()).rejects.toThrow("audio_meter_close_failed");
    expect(context.preflight.lifecycle()).toBe("failed");
    expect(context.preflight.previews()).toHaveLength(1);
    await context.preflight.stopPreview();
    expect(context.closedMeters).toHaveLength(1);
    expect(context.preflight.previews()).toEqual([]);
    expect(context.preflight.lifecycle()).toBe("idle");
    expect(context.microphone.stop).not.toHaveBeenCalled();
  });
});
