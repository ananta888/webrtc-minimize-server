import { Injectable } from "@angular/core";

export interface VoskRecognitionMessage {
  readonly error?: string;
  readonly result?: Readonly<{ partial?: string; text?: string }>;
}

export interface VoskRecognizerPort {
  on(event: "partialresult" | "result" | "error", listener: (message: VoskRecognitionMessage) => void): void;
  setWords(enabled: boolean): void;
  acceptWaveformFloat(buffer: Float32Array, sampleRate: number): void;
  retrieveFinalResult(): void;
  remove(): void;
}

export interface VoskModelPort {
  readonly ready: boolean;
  readonly KaldiRecognizer: new (sampleRate: number, grammar?: string) => VoskRecognizerPort;
  terminate(): void;
  setLogLevel(level: number): void;
}

type RecognitionEvent = "partialresult" | "result" | "error";

interface WorkerMessage {
  readonly event?: string;
  readonly recognizerId?: string;
  readonly error?: string;
  readonly result?: Readonly<{ partial?: string; text?: string }> | boolean;
}

class WorkerRecognizer implements VoskRecognizerPort {
  readonly id = crypto.randomUUID();
  private readonly listeners = new Map<RecognitionEvent, Set<(message: VoskRecognitionMessage) => void>>();
  private removed = false;

  constructor(
    private readonly model: WorkerModel,
    sampleRate: number,
    grammar?: string,
  ) {
    this.model.register(this);
    this.model.send({ action: "create", recognizerId: this.id, sampleRate, grammar });
  }

  on(event: RecognitionEvent, listener: (message: VoskRecognitionMessage) => void): void {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  setWords(enabled: boolean): void {
    this.model.send({ action: "set", recognizerId: this.id, key: "words", value: enabled });
  }

  acceptWaveformFloat(buffer: Float32Array, sampleRate: number): void {
    if (this.removed) throw new Error("Der Vosk-Recognizer wurde bereits beendet.");
    const data = buffer.map((value) => value * 0x8000);
    this.model.send({ action: "audioChunk", recognizerId: this.id, data, sampleRate }, [data.buffer]);
  }

  retrieveFinalResult(): void {
    if (!this.removed) this.model.send({ action: "retrieveFinalResult", recognizerId: this.id });
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.model.unregister(this.id);
    this.model.send({ action: "remove", recognizerId: this.id });
    this.listeners.clear();
  }

  dispatch(event: RecognitionEvent, message: VoskRecognitionMessage): void {
    for (const listener of this.listeners.get(event) || []) listener(message);
  }
}

class WorkerModel implements VoskModelPort {
  ready = false;
  readonly KaldiRecognizer: new (sampleRate: number, grammar?: string) => VoskRecognizerPort;
  private readonly worker: Worker;
  private readonly recognizers = new Map<string, WorkerRecognizer>();
  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;
  private abortSignal: AbortSignal | null = null;
  private terminated = false;

  constructor(workerUrl: string) {
    const owner = this;
    this.KaldiRecognizer = class extends WorkerRecognizer {
      constructor(sampleRate: number, grammar?: string) {
        super(owner, sampleRate, grammar);
      }
    };
    this.worker = new Worker(workerUrl, { name: "vosk-recognizer-v1" });
    this.worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => this.handleMessage(data));
    this.worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "Der Vosk-Worker konnte nicht ausgeführt werden."));
    });
    this.worker.addEventListener("messageerror", () => this.fail(new Error("Der Vosk-Worker lieferte ungültige Daten.")));
  }

  load(modelUrl: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("Der Modellstart wurde abgebrochen.", "AbortError"));
    return new Promise((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      this.abortSignal = signal || null;
      signal?.addEventListener("abort", this.abort, { once: true });
      this.send({ action: "set", key: "logLevel", value: -1 });
      this.send({ action: "load", modelUrl });
    });
  }

  register(recognizer: WorkerRecognizer): void {
    if (!this.ready || this.terminated) throw new Error("Das Vosk-Modell ist nicht betriebsbereit.");
    this.recognizers.set(recognizer.id, recognizer);
  }

  unregister(recognizerId: string): void {
    this.recognizers.delete(recognizerId);
  }

  send(message: object, transfer: Transferable[] = []): void {
    if (!this.terminated) this.worker.postMessage(message, transfer);
  }

  setLogLevel(level: number): void {
    this.send({ action: "set", key: "logLevel", value: level });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.ready = false;
    this.cleanupLoad();
    this.recognizers.clear();
    this.worker.terminate();
  }

  private readonly abort = () => {
    this.fail(new DOMException("Der Modellstart wurde abgebrochen.", "AbortError"));
  };

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const message = raw as WorkerMessage;
    if (message.recognizerId) {
      const recognizer = this.recognizers.get(message.recognizerId);
      if (recognizer && (message.event === "partialresult" || message.event === "result" || message.event === "error")) {
        recognizer.dispatch(message.event, {
          error: message.error,
          result: typeof message.result === "object" ? message.result : undefined,
        });
      }
      return;
    }
    if (message.event === "load") {
      if (message.result === true) {
        this.ready = true;
        const resolve = this.loadResolve;
        this.cleanupLoad();
        resolve?.();
      } else {
        this.fail(new Error("Der Vosk-Worker konnte das Modell nicht initialisieren."));
      }
    } else if (message.event === "error") {
      this.fail(new Error(message.error || "Der Vosk-Worker hat einen unbekannten Fehler gemeldet."));
    }
  }

  private fail(error: Error): void {
    const reject = this.loadReject;
    this.cleanupLoad();
    if (reject) {
      reject(error);
      return;
    }
    this.ready = false;
    for (const recognizer of [...this.recognizers.values()]) {
      recognizer.dispatch("error", { error: error.message });
    }
    this.terminate();
  }

  private cleanupLoad(): void {
    this.abortSignal?.removeEventListener("abort", this.abort);
    this.abortSignal = null;
    this.loadResolve = null;
    this.loadReject = null;
  }
}

@Injectable({ providedIn: "root" })
export class VoskRuntimeAdapter {
  async loadModel(archive: Blob, signal?: AbortSignal): Promise<VoskModelPort> {
    const modelUrl = URL.createObjectURL(archive);
    let model: WorkerModel | null = null;
    try {
      model = new WorkerModel("/assets/vosk-worker.js");
      await model.load(modelUrl, signal);
      return model;
    } catch (error) {
      model?.terminate();
      throw error;
    } finally {
      URL.revokeObjectURL(modelUrl);
    }
  }
}
