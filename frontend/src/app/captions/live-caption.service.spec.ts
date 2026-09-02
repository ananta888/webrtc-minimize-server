import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "@angular/core";

import { LiveCaptionService } from "./live-caption.service";

function fixture(options: { microphone?: boolean; modelReady?: boolean; participants?: number } = {}) {
  const track = {
    id: "microphone-track",
    kind: "audio",
    readyState: "live",
  } as MediaStreamTrack;
  let stopListener = () => undefined;
  const media = {
    microphoneTrack: vi.fn(() => options.microphone === false ? null : track),
    registerMicrophoneStopListener: vi.fn((listener: () => void) => {
      stopListener = listener;
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
  const listeners = new Map<string, (message: { error?: string; result?: { partial?: string; text?: string } }) => void>();
  const recognizer = {
    on: vi.fn((event: string, listener: (message: never) => void) => listeners.set(event, listener)),
    setWords: vi.fn(),
    acceptWaveformFloat: vi.fn(),
    retrieveFinalResult: vi.fn(),
    remove: vi.fn(),
  };
  const models = {
    ready: signal(options.modelReady !== false),
    selectedModel: signal({ languageTag: "de-DE" }),
    createRecognizer: vi.fn(() => recognizer),
    unload: vi.fn(),
    destroy: vi.fn(),
  };
  const close = vi.fn(async () => undefined);
  let consume: ((samples: Float32Array, sampleRate: number) => void) | null = null;
  const audio = {
    supported: vi.fn(() => true),
    connect: vi.fn(async (_track: MediaStreamTrack, consumer: typeof consume) => {
      consume = consumer;
      return { sampleRate: 48_000, close };
    }),
  };
  const service = new LiveCaptionService(media as never, mesh as never, models as never, audio as never);
  return {
    service,
    media,
    mesh,
    models,
    audio,
    recognizer,
    listeners,
    sendCaption,
    close,
    stopMicrophone: () => stopListener(),
    consume: (samples: Float32Array, sampleRate: number) => consume?.(samples, sampleRate),
  };
}

describe("LiveCaptionService", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed without an already active microphone and never requests capture", async () => {
    const test = fixture({ microphone: false });
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });

    expect(await test.service.start()).toBe(false);
    expect(test.audio.connect).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(test.service.error()).toContain("Starte zuerst bewusst dein Mikrofon");
  });

  it("feeds AudioWorklet PCM into Vosk and sends bounded partial and final updates", async () => {
    const test = fixture();
    expect(await test.service.start()).toBe(true);
    expect(test.models.createRecognizer).toHaveBeenCalledWith(48_000);
    test.consume(new Float32Array(4096), 48_000);
    expect(test.recognizer.acceptWaveformFloat).toHaveBeenCalledWith(expect.any(Float32Array), 48_000);

    test.listeners.get("partialresult")?.({ result: { partial: "guten" } });
    expect(test.sendCaption).toHaveBeenCalledWith(expect.objectContaining({
      revision: 0,
      language: "de-DE",
      text: "guten",
      final: false,
    }));
    test.listeners.get("partialresult")?.({ result: { partial: "guten morgen" } });
    expect(test.sendCaption).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(test.sendCaption).toHaveBeenCalledTimes(2);
    test.listeners.get("result")?.({ result: { text: "guten morgen zusammen" } });
    expect(test.sendCaption).toHaveBeenLastCalledWith(expect.objectContaining({
      revision: 2,
      text: "guten morgen zusammen",
      final: true,
    }));
    expect(test.service.partialText()).toBe("");
  });

  it("stops the cloned recognition path when the publication service stops the microphone", async () => {
    const test = fixture();
    await test.service.start();
    test.stopMicrophone();

    expect(test.recognizer.remove).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.models.unload).toHaveBeenCalledOnce();
    expect(test.service.active()).toBe(false);
  });
});
