import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoskRuntimeAdapter } from "./vosk-runtime-adapter";

type WorkerListener = (event: MessageEvent<unknown> | ErrorEvent) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly messages: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = [];
  readonly listeners = new Map<string, Set<WorkerListener>>();
  terminated = false;

  constructor(readonly url: string, readonly options: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.messages.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of this.listeners.get("message") || []) listener(event);
  }
}

describe("VoskRuntimeAdapter", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "recognizer-1") });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:https://webrtc.test/model"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads the isolated worker and forwards bounded recognizer audio by transfer", async () => {
    const adapter = new VoskRuntimeAdapter();
    const loading = adapter.loadModel(new Blob(["model"]));
    const worker = FakeWorker.instances[0];
    expect(worker.url).toBe("/assets/vosk-worker.js");
    expect(worker.options.name).toBe("vosk-recognizer-v1");
    expect(worker.messages.map(({ message }) => message["action"])).toEqual(["set", "load"]);
    worker.emit({ event: "load", result: true });

    const model = await loading;
    expect(model.ready).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://webrtc.test/model");
    const recognizer = new model.KaldiRecognizer(16_000);
    const partial = vi.fn();
    recognizer.on("partialresult", partial);
    recognizer.setWords(false);
    recognizer.acceptWaveformFloat(new Float32Array([0.5, -0.25]), 16_000);
    worker.emit({ event: "partialresult", recognizerId: "recognizer-1", result: { partial: "hallo" } });

    expect(partial).toHaveBeenCalledWith({ error: undefined, result: { partial: "hallo" } });
    const audio = worker.messages.find(({ message }) => message["action"] === "audioChunk");
    expect(audio?.message["data"]).toEqual(new Float32Array([16_384, -8_192]));
    expect(audio?.transfer).toHaveLength(1);
    recognizer.remove();
    model.terminate();
    expect(worker.terminated).toBe(true);
  });

  it("terminates the worker and rejects when loading is cancelled", async () => {
    const adapter = new VoskRuntimeAdapter();
    const controller = new AbortController();
    const loading = adapter.loadModel(new Blob(["model"]), controller.signal);
    const worker = FakeWorker.instances[0];
    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("surfaces the worker error and releases its resources", async () => {
    const adapter = new VoskRuntimeAdapter();
    const loading = adapter.loadModel(new Blob(["model"]));
    const worker = FakeWorker.instances[0];
    worker.emit({ event: "error", error: "Modellarchiv ist beschädigt" });

    await expect(loading).rejects.toThrow("Modellarchiv ist beschädigt");
    expect(worker.terminated).toBe(true);
  });

  it("notifies active recognizers and terminates on a global runtime error", async () => {
    const adapter = new VoskRuntimeAdapter();
    const loading = adapter.loadModel(new Blob(["model"]));
    const worker = FakeWorker.instances[0];
    worker.emit({ event: "load", result: true });
    const model = await loading;
    const recognizer = new model.KaldiRecognizer(16_000);
    const error = vi.fn();
    recognizer.on("error", error);

    worker.emit({ event: "error", error: "Recognizer-Laufzeitfehler" });

    expect(error).toHaveBeenCalledWith({ error: "Recognizer-Laufzeitfehler" });
    expect(model.ready).toBe(false);
    expect(worker.terminated).toBe(true);
  });
});
