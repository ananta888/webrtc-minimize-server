import { beforeEach, describe, expect, it, vi } from "vitest";

import { VoskModelManagerService } from "./vosk-model-manager.service";
import { VoskModelPort, VoskRecognizerPort } from "./vosk-runtime-adapter";

function runtimeModel() {
  const recognizer = {
    on: vi.fn(),
    setWords: vi.fn(),
    acceptWaveformFloat: vi.fn(),
    retrieveFinalResult: vi.fn(),
    remove: vi.fn(),
  } as unknown as VoskRecognizerPort;
  const KaldiRecognizer = vi.fn(function Recognizer() { return recognizer; });
  const model = {
    ready: true,
    KaldiRecognizer,
    terminate: vi.fn(),
    setLogLevel: vi.fn(),
  } as unknown as VoskModelPort;
  return { model, recognizer, KaldiRecognizer };
}

describe("VoskModelManagerService", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("does not download or initialize a model before an explicit load action", () => {
    const runtime = { loadModel: vi.fn() };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const service = new VoskModelManagerService(runtime as never);

    expect(service.selectedModelId()).toBe("de-de-small-0.15");
    expect(service.status()).toBe("idle");
    expect(runtime.loadModel).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.select("https://attacker.invalid/model.tar.gz")).toBe(false);
  });

  it("loads only the selected allowlisted archive and creates a recognizer", async () => {
    const { model, recognizer, KaldiRecognizer } = runtimeModel();
    const runtime = { loadModel: vi.fn(async () => model) };
    const service = new VoskModelManagerService(runtime as never);
    const archive = new Blob([new Uint8Array([0x1f, 0x8b])], { type: "application/gzip" });
    const archiveLoader = vi.fn(async () => archive);
    (service as unknown as { modelArchive: typeof archiveLoader }).modelArchive = archiveLoader;

    expect(service.select("en-us-small-0.15")).toBe(true);
    expect(await service.loadSelected()).toBe(true);
    expect(archiveLoader).toHaveBeenCalledWith(
      expect.objectContaining({ id: "en-us-small-0.15" }),
      expect.any(AbortSignal),
    );
    expect(runtime.loadModel).toHaveBeenCalledWith(archive, expect.any(AbortSignal));
    expect(service.ready()).toBe(true);
    const created = service.createRecognizer(48_000);
    expect(created).toBe(recognizer);
    expect(KaldiRecognizer).toHaveBeenCalledWith(48_000);
    expect(recognizer.setWords).toHaveBeenCalledWith(false);

    expect(service.select("de-de-small-0.15")).toBe(true);
    expect(model.terminate).toHaveBeenCalledOnce();
    expect(service.ready()).toBe(false);
    service.unload();
    expect(model.terminate).toHaveBeenCalledOnce();
    expect(service.status()).toBe("idle");
  });

  it("surfaces a controlled runtime failure and remains reloadable", async () => {
    const runtime = { loadModel: vi.fn(async () => { throw new Error("WASM blockiert"); }) };
    const service = new VoskModelManagerService(runtime as never);
    (service as unknown as { modelArchive: () => Promise<Blob> }).modelArchive = async () => new Blob();

    expect(await service.loadSelected()).toBe(false);
    expect(service.status()).toBe("error");
    expect(service.error()).toBe("WASM blockiert");
  });
});
