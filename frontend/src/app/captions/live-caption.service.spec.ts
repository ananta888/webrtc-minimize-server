import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptionAudioSource } from "../webrtc/caption-contract";
import { LiveCaptionService } from "./live-caption.service";

interface FakeRecognizer {
  readonly listeners: Map<string, (message: { error?: string; result?: { partial?: string; text?: string } }) => void>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly setWords: ReturnType<typeof vi.fn>;
  readonly acceptWaveformFloat: ReturnType<typeof vi.fn>;
  readonly retrieveFinalResult: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
}

function fixture(options: { microphone?: boolean; screenAudio?: boolean; modelReady?: boolean; participants?: number } = {}) {
  const microphoneTrack = { id: "microphone-track", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const screenAudioTrack = { id: "screen-audio-track", kind: "audio", readyState: "live" } as MediaStreamTrack;
  let microphoneStopListener = () => undefined;
  let screenAudioStopListener = () => undefined;
  const media = {
    microphoneTrack: vi.fn(() => options.microphone === false ? null : microphoneTrack),
    screenAudioTrack: vi.fn(() => options.screenAudio === false ? null : screenAudioTrack),
    registerMicrophoneStopListener: vi.fn((listener: () => void) => {
      microphoneStopListener = listener;
      return vi.fn();
    }),
    registerScreenAudioStopListener: vi.fn((listener: () => void) => {
      screenAudioStopListener = listener;
      return vi.fn();
    }),
  };
  const sendCaption = vi.fn(() => true);
  const mesh = {
    participantCount: signal(options.participants ?? 2),
    captions: signal([]),
    sendCaption,
    clearCaptions: vi.fn(),
  };
  const recognizers: FakeRecognizer[] = [];
  const createRecognizer = () => {
    const listeners = new Map<string, (message: { error?: string; result?: { partial?: string; text?: string } }) => void>();
    const recognizer: FakeRecognizer = {
      listeners,
      on: vi.fn((event: string, listener: (message: never) => void) => listeners.set(event, listener)),
      setWords: vi.fn(),
      acceptWaveformFloat: vi.fn(),
      retrieveFinalResult: vi.fn(),
      remove: vi.fn(),
    };
    recognizers.push(recognizer);
    return recognizer;
  };
  const models = {
    ready: signal(options.modelReady !== false),
    selectedModel: signal({ languageTag: "de-DE" }),
    createRecognizer: vi.fn(createRecognizer),
    unload: vi.fn(),
    destroy: vi.fn(),
  };
  const consumers = new Map<string, (samples: Float32Array, sampleRate: number) => void>();
  const graphCloses = new Map<string, ReturnType<typeof vi.fn>>();
  const audio = {
    supported: vi.fn(() => true),
    connect: vi.fn(async (track: MediaStreamTrack, consumer: (samples: Float32Array, sampleRate: number) => void) => {
      consumers.set(track.id, consumer);
      const close = vi.fn(async () => undefined);
      graphCloses.set(track.id, close);
      return { sampleRate: 48_000, close };
    }),
  };
  const service = new LiveCaptionService(media as never, mesh as never, models as never, audio as never);
  const recognizerFor = (source: CaptionAudioSource) => recognizers[source === "microphone" ? 0 : recognizers.length - 1];
  return {
    service,
    media,
    mesh,
    models,
    audio,
    recognizers,
    sendCaption,
    microphoneTrack,
    screenAudioTrack,
    stopMicrophone: () => microphoneStopListener(),
    stopScreenAudio: () => screenAudioStopListener(),
    consume: (source: CaptionAudioSource, samples: Float32Array, sampleRate: number) => {
      consumers.get(source === "microphone" ? microphoneTrack.id : screenAudioTrack.id)?.(samples, sampleRate);
    },
    closeFor: (source: CaptionAudioSource) => graphCloses.get(source === "microphone" ? microphoneTrack.id : screenAudioTrack.id),
    recognizerFor,
  };
}

describe("LiveCaptionService", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("does not expand caption sharing before the user explicitly opts in", () => {
    const test = fixture();
    expect(test.service.shareWithRoom()).toBe(false);
  });

  it("fails closed without an already active microphone and never requests capture", async () => {
    const test = fixture({ microphone: false });
    const getUserMedia = vi.fn();
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, getDisplayMedia } });

    expect(await test.service.start("microphone")).toBe(false);
    expect(test.audio.connect).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(test.service.error()).toContain("Starte zuerst bewusst dein Mikrofon");
  });

  it("feeds microphone PCM into Vosk and sends bounded partial and final updates", async () => {
    const test = fixture();
    const emissions: Record<string, unknown>[] = [];
    const unregister = test.service.registerEmissionListener((value) => emissions.push(value));
    expect(test.service.setShareWithRoom(true)).toBe(true);
    expect(await test.service.start("microphone")).toBe(true);
    const recognizer = test.recognizerFor("microphone");
    expect(test.models.createRecognizer).toHaveBeenCalledWith(48_000);
    test.consume("microphone", new Float32Array(4096), 48_000);
    expect(recognizer.acceptWaveformFloat).toHaveBeenCalledWith(expect.any(Float32Array), 48_000);

    recognizer.listeners.get("partialresult")?.({ result: { partial: "guten" } });
    expect(test.sendCaption).toHaveBeenCalledWith(expect.objectContaining({
      revision: 0,
      language: "de-DE",
      text: "guten",
      final: false,
      source: "microphone",
    }), true);
    recognizer.listeners.get("partialresult")?.({ result: { partial: "guten morgen" } });
    expect(test.sendCaption).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(test.sendCaption).toHaveBeenCalledTimes(2);
    recognizer.listeners.get("result")?.({ result: { text: "guten morgen zusammen" } });
    expect(test.sendCaption).toHaveBeenLastCalledWith(expect.objectContaining({
      revision: 2,
      text: "guten morgen zusammen",
      final: true,
      source: "microphone",
    }), true);
    expect(test.service.partialText()).toBe("");
    expect(emissions).toHaveLength(3);
    expect(emissions.at(-1)).toMatchObject({
      source: "microphone", sourceEpoch: 1, revision: 2,
      language: "de-DE", text: "guten morgen zusammen", final: true,
    });
    expect(emissions.at(-1)?.["capturedAtMs"]).toEqual(expect.any(Number));
    unregister();
  });

  it("transcribes only an existing screen-audio track and keeps text local when selected", async () => {
    const test = fixture({ microphone: false });
    expect(test.service.selectSource("screen-audio")).toBe(true);
    expect(test.service.setShareWithRoom(false)).toBe(true);
    expect(await test.service.start()).toBe(true);
    const recognizer = test.recognizerFor("screen-audio");

    expect(test.audio.connect).toHaveBeenCalledWith(test.screenAudioTrack, expect.any(Function));
    recognizer.listeners.get("result")?.({ result: { text: "geteilte präsentation" } });

    expect(test.sendCaption).toHaveBeenCalledWith(expect.objectContaining({
      text: "geteilte präsentation",
      final: true,
      source: "screen-audio",
    }), false);
    expect(test.service.setShareWithRoom(true)).toBe(false);
    expect(test.service.shareWithRoom()).toBe(false);
  });

  it("runs both audio sources and stops only the publication that ended", async () => {
    const test = fixture();
    expect(await test.service.start("microphone")).toBe(true);
    expect(await test.service.start("screen-audio")).toBe(true);
    expect(test.service.activeSources()).toEqual(["microphone", "screen-audio"]);
    const microphoneRecognizer = test.recognizers[0];
    const screenRecognizer = test.recognizers[1];

    test.stopScreenAudio();

    expect(screenRecognizer.remove).toHaveBeenCalledOnce();
    expect(test.closeFor("screen-audio")).toHaveBeenCalledOnce();
    expect(microphoneRecognizer.remove).not.toHaveBeenCalled();
    expect(test.closeFor("microphone")).not.toHaveBeenCalled();
    expect(test.models.unload).not.toHaveBeenCalled();
    expect(test.service.activeSources()).toEqual(["microphone"]);

    test.stopMicrophone();
    expect(microphoneRecognizer.remove).toHaveBeenCalledOnce();
    expect(test.closeFor("microphone")).toHaveBeenCalledOnce();
    expect(test.models.unload).toHaveBeenCalledOnce();
    expect(test.service.active()).toBe(false);
  });

  it("rejects screen transcription when display capture supplied no audio track", async () => {
    const test = fixture({ screenAudio: false });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });

    expect(await test.service.start("screen-audio")).toBe(false);
    expect(test.service.error()).toContain("Bildschirm oder Tab mit Ton");
    expect(test.audio.connect).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});
