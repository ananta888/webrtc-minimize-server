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
  const captionsSignal = signal<unknown[]>([]);
  const mesh = {
    participantCount: signal(options.participants ?? 2),
    captions: captionsSignal,
    sendCaption,
    clearCaptions: vi.fn(() => captionsSignal.set([])),
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
    const stopped = vi.fn(); test.service.registerSourceStopListener(stopped);
    expect(await test.service.start("microphone")).toBe(true);
    expect(await test.service.start("screen-audio")).toBe(true);
    expect(test.service.activeSources()).toEqual(["microphone", "screen-audio"]);
    const microphoneRecognizer = test.recognizers[0];
    const screenRecognizer = test.recognizers[1];

    test.stopScreenAudio();
    expect(stopped).toHaveBeenCalledExactlyOnceWith("screen-audio", 2);

    expect(screenRecognizer.remove).toHaveBeenCalledOnce();
    expect(test.closeFor("screen-audio")).toHaveBeenCalledOnce();
    expect(microphoneRecognizer.remove).not.toHaveBeenCalled();
    expect(test.closeFor("microphone")).not.toHaveBeenCalled();
    expect(test.models.unload).not.toHaveBeenCalled();
    expect(test.service.activeSources()).toEqual(["microphone"]);

    test.stopMicrophone();
    expect(stopped).toHaveBeenLastCalledWith("microphone", 2);
    expect(microphoneRecognizer.remove).toHaveBeenCalledOnce();
    expect(test.closeFor("microphone")).toHaveBeenCalledOnce();
    expect(test.models.unload).toHaveBeenCalledOnce();
    expect(test.service.active()).toBe(false);
  });

  it("fences optional broadcast consumers before final room text and isolates failing stop listeners", async () => {
    const test = fixture(), events: string[] = [];
    test.service.registerSourceStopListener(() => { throw new Error("synthetic optional consumer"); });
    const unregister = test.service.registerSourceStopListener((source, epoch) => events.push(`stop:${source}:${epoch}`));
    test.service.registerEmissionListener(value => events.push(`${value.final ? "final" : "partial"}:${value.sourceEpoch}`));
    expect(await test.service.start("microphone")).toBe(true);
    test.recognizerFor("microphone").listeners.get("partialresult")?.({ result: { partial: "synthetic pending text" } });
    test.stopMicrophone();
    expect(events).toEqual(["partial:1", "stop:microphone:2", "final:1"]);
    expect(test.recognizers[0].remove).toHaveBeenCalledOnce(); expect(test.closeFor("microphone")).toHaveBeenCalledOnce();
    expect(test.sendCaption).toHaveBeenLastCalledWith(expect.objectContaining({ final: true, text: "synthetic pending text" }), false);
    expect(await test.service.start("microphone")).toBe(true);
    test.recognizers[1].listeners.get("result")?.({ result: { text: "fresh text" } });
    expect(events.at(-1)).toBe("final:3");
    unregister(); test.service.stop("microphone");
    expect(events.filter(value => value.startsWith("stop:"))).toEqual(["stop:microphone:2"]);
    const afterDestroy = vi.fn(); test.service.registerSourceStopListener(afterDestroy);
    test.service.destroy(); const calls = afterDestroy.mock.calls.length;
    test.service.stop(); expect(afterDestroy).toHaveBeenCalledTimes(calls);
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

  it("reports the stop fence while a graph is still starting and never emits from the late graph", async () => {
    const test = fixture(), stopped = vi.fn(), emitted = vi.fn(), close = vi.fn(async () => undefined);
    test.service.registerSourceStopListener(stopped); test.service.registerEmissionListener(emitted);
    let release!: (graph: { sampleRate: number; close: typeof close }) => void;
    test.audio.connect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = test.service.start("screen-audio");
    expect(test.service.isSourceStarting("screen-audio")).toBe(true);
    test.service.stop("screen-audio");
    expect(stopped).toHaveBeenCalledExactlyOnceWith("screen-audio", 2);
    release({ sampleRate: 48000, close });
    await expect(pending).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce(); expect(emitted).not.toHaveBeenCalled();
    expect(test.models.createRecognizer).not.toHaveBeenCalled(); expect(test.service.active()).toBe(false);
    test.service.destroy();
  });

  it("manages overlay position, font size, and max lines preferences", () => {
    const test = fixture();
    expect(test.service.overlayPosition()).toBe("bottom");
    expect(test.service.overlayFontSize()).toBe("medium");
    expect(test.service.overlayMaxLines()).toBe(3);

    expect(test.service.setOverlayPosition("top")).toBe(true);
    expect(test.service.overlayPosition()).toBe("top");
    expect(localStorage.getItem("webrtc-caption-position-v1")).toBe("top");
    expect(test.service.setOverlayPosition("invalid")).toBe(false);
    expect(test.service.overlayPosition()).toBe("top");

    expect(test.service.setOverlayFontSize("large")).toBe(true);
    expect(test.service.overlayFontSize()).toBe("large");
    expect(localStorage.getItem("webrtc-caption-size-v1")).toBe("large");
    expect(test.service.setOverlayFontSize("huge")).toBe(false);

    expect(test.service.setOverlayMaxLines(5)).toBe(true);
    expect(test.service.overlayMaxLines()).toBe(5);
    expect(localStorage.getItem("webrtc-caption-lines-v1")).toBe("5");
    expect(test.service.setOverlayMaxLines(0)).toBe(false);
    expect(test.service.setOverlayMaxLines(6)).toBe(false);
    expect(test.service.setOverlayMaxLines("invalid")).toBe(false);

    test.service.resetOverlaySettings();
    expect(test.service.overlayPosition()).toBe("bottom");
    expect(test.service.overlayFontSize()).toBe("medium");
    expect(test.service.overlayMaxLines()).toBe(3);
  });

  it("limits overlay entries to the configured max lines", () => {
    const test = fixture();
    const entries = [1, 2, 3, 4, 5].map((i) => ({
      id: `caption-${i}`,
      peerId: "p1",
      author: "Alice",
      language: "de-DE",
      text: `Zeile ${i}`,
      final: true,
      local: false,
      source: "microphone" as const,
      sharedWithRoom: true,
      receivedAt: Date.now(),
    }));
    test.mesh.captions.set(entries as never);

    test.service.setOverlayMaxLines(2);
    expect(test.service.overlayEntries()).toHaveLength(2);
    expect(test.service.overlayEntries()[0].text).toBe("Zeile 4");
    expect(test.service.overlayEntries()[1].text).toBe("Zeile 5");

    test.service.setOverlayMaxLines(4);
    expect(test.service.overlayEntries()).toHaveLength(4);
    expect(test.service.overlayEntries()[0].text).toBe("Zeile 2");
  });

  it("formats transcript text with privacy disclaimer and speaker metadata", () => {
    const test = fixture();
    expect(test.service.formatTranscriptText()).toBe("");

    const now = new Date("2026-09-11T12:00:00Z").getTime();
    test.mesh.captions.set([
      {
        id: "c1",
        peerId: "p-local",
        author: "Du",
        language: "de-DE",
        text: "Hallo allerseits",
        final: true,
        local: true,
        source: "microphone",
        sharedWithRoom: true,
        receivedAt: now,
      },
      {
        id: "c2",
        peerId: "p-remote",
        author: "Bob",
        language: "de-DE",
        text: "Moin moin",
        final: false,
        local: false,
        source: "screen-audio",
        sharedWithRoom: true,
        receivedAt: now + 5000,
      },
    ] as never);

    const formatted = test.service.formatTranscriptText();
    expect(formatted).toContain("# webrtc-minimize-server Untertitel-Transkript");
    expect(formatted).toContain("# Datenschutzhinweis: Nur mit Zustimmung aller Gesprächsteilnehmer verwenden.");
    expect(formatted).toContain("Du (microphone, de-DE): Hallo allerseits");
    expect(formatted).toContain("Bob (screen-audio, de-DE): Moin moin [unvollständig]");
  });

  it("downloads local transcript via blob and revokes object URL", () => {
    const test = fixture();
    expect(test.service.downloadTranscript()).toBe(false);

    test.mesh.captions.set([
      {
        id: "c1",
        peerId: "p1",
        author: "Du",
        language: "de-DE",
        text: "Testausgabe",
        final: true,
        local: true,
        source: "microphone",
        sharedWithRoom: false,
        receivedAt: Date.now(),
      },
    ] as never);

    const createObjectURL = vi.fn(() => "blob:https://localhost/transcript-123");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    const appendChild = vi.spyOn(document.body, "appendChild");
    const removeChild = vi.spyOn(document.body, "removeChild");

    expect(test.service.downloadTranscript()).toBe(true);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://localhost/transcript-123");
    expect(appendChild).toHaveBeenCalledOnce();
    expect(removeChild).toHaveBeenCalledOnce();

    test.service.clear();
    expect(test.mesh.clearCaptions).toHaveBeenCalled();
    expect(test.service.formatTranscriptText()).toBe("");
  });
});
