import { Injectable, computed, signal } from "@angular/core";

import {
  DEFAULT_VOSK_MODEL_ID,
  VOSK_BROWSER_MODELS,
  VoskBrowserModel,
  findVoskModel,
} from "./vosk-model-catalog";
import { VoskModelPort, VoskRecognizerPort, VoskRuntimeAdapter } from "./vosk-runtime-adapter";

export type VoskModelStatus = "idle" | "downloading" | "preparing" | "ready" | "error";

const SELECTED_MODEL_STORAGE_KEY = "webrtc-vosk-model-v1";
const MODEL_CACHE = "webrtc-vosk-models-v1";

function initialModelId(): string {
  try {
    const stored = localStorage.getItem(SELECTED_MODEL_STORAGE_KEY);
    return findVoskModel(stored)?.id || DEFAULT_VOSK_MODEL_ID;
  } catch {
    return DEFAULT_VOSK_MODEL_ID;
  }
}

@Injectable({ providedIn: "root" })
export class VoskModelManagerService {
  readonly models = VOSK_BROWSER_MODELS;
  readonly selectedModelId = signal(initialModelId());
  readonly selectedModel = computed(() => findVoskModel(this.selectedModelId())!);
  readonly loadedModelId = signal("");
  readonly status = signal<VoskModelStatus>("idle");
  readonly progress = signal(0);
  readonly error = signal("");
  readonly cachedModelIds = signal<readonly string[]>([]);
  readonly ready = computed(() => this.status() === "ready" && this.loadedModelId() === this.selectedModelId());
  private loadedModel: VoskModelPort | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;

  constructor(private readonly runtime: VoskRuntimeAdapter) {
    void this.refreshCachedModels();
  }

  select(modelId: unknown): boolean {
    const model = findVoskModel(modelId);
    if (!model || this.status() === "downloading" || this.status() === "preparing") return false;
    if (model.id !== this.selectedModelId()) {
      this.releaseLoadedModel();
      this.status.set("idle");
      this.progress.set(0);
    }
    this.selectedModelId.set(model.id);
    this.error.set("");
    try { localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, model.id); } catch { /* optional preference */ }
    return true;
  }

  async loadSelected(): Promise<boolean> {
    if (this.status() === "downloading" || this.status() === "preparing") return false;
    const selected = this.selectedModel();
    if (this.loadedModel && this.loadedModelId() === selected.id && this.loadedModel.ready) {
      this.status.set("ready");
      return true;
    }
    const generation = ++this.generation;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.releaseLoadedModel();
    this.error.set("");
    this.progress.set(0);
    try {
      const archive = await this.modelArchive(selected, abortController.signal);
      if (generation !== this.generation) return false;
      this.status.set("preparing");
      this.progress.set(100);
      const loaded = await this.runtime.loadModel(archive, abortController.signal);
      if (generation !== this.generation) {
        loaded.terminate();
        return false;
      }
      if (!loaded.ready) {
        loaded.terminate();
        throw new Error("Das Vosk-Modell wurde nicht betriebsbereit.");
      }
      loaded.setLogLevel(-1);
      this.loadedModel = loaded;
      this.loadedModelId.set(selected.id);
      this.status.set("ready");
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.status.set(abortController.signal.aborted ? "idle" : "error");
      this.progress.set(0);
      this.error.set(abortController.signal.aborted
        ? ""
        : error instanceof Error ? error.message : "Vosk-Modell konnte nicht geladen werden.");
      return false;
    } finally {
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  cancelLoad(): void {
    if (this.status() !== "downloading" && this.status() !== "preparing") return;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.status.set("idle");
    this.progress.set(0);
    this.error.set("");
  }

  createRecognizer(sampleRate: number): VoskRecognizerPort {
    if (!this.loadedModel?.ready || !this.ready()) throw new Error("Bitte lade zuerst das ausgewählte Vosk-Modell.");
    const recognizer = new this.loadedModel.KaldiRecognizer(sampleRate);
    recognizer.setWords(false);
    return recognizer;
  }

  async removeCachedModel(modelId: string): Promise<void> {
    const model = findVoskModel(modelId);
    if (!model) return;
    if (this.loadedModelId() === model.id) {
      this.releaseLoadedModel();
      this.status.set("idle");
      this.progress.set(0);
      this.error.set("");
    }
    if (typeof caches !== "undefined") {
      try {
        const cache = await caches.open(MODEL_CACHE);
        await cache.delete(this.cacheRequest(model));
      } catch {
        // Cache storage is optional and may be unavailable in private browsing modes.
      }
    }
    await this.refreshCachedModels();
  }

  async refreshCachedModels(): Promise<void> {
    if (typeof caches === "undefined") {
      this.cachedModelIds.set([]);
      return;
    }
    try {
      const cache = await caches.open(MODEL_CACHE);
      const cached = await Promise.all(this.models.map(async (model) => (
        await cache.match(this.cacheRequest(model)) ? model.id : ""
      )));
      this.cachedModelIds.set(cached.filter(Boolean));
    } catch {
      this.cachedModelIds.set([]);
    }
  }

  isCached(modelId: string): boolean {
    return this.cachedModelIds().includes(modelId);
  }

  unload(): void {
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.releaseLoadedModel();
    this.status.set("idle");
    this.progress.set(0);
    this.error.set("");
  }

  destroy(): void {
    this.unload();
  }

  private async modelArchive(model: VoskBrowserModel, signal: AbortSignal): Promise<Blob> {
    const cached = await this.readCachedModel(model);
    if (cached) {
      this.status.set("preparing");
      this.progress.set(100);
      return cached;
    }
    this.status.set("downloading");
    const response = await fetch(model.sourceUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Modell-Download fehlgeschlagen (HTTP ${response.status}).`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength && declaredLength !== model.sizeBytes) throw new Error("Die gemeldete Modellgröße stimmt nicht mit dem Katalog überein.");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > model.sizeBytes) {
        await reader.cancel();
        throw new Error("Das Modell überschreitet die erlaubte Kataloggröße.");
      }
      chunks.push(value as Uint8Array<ArrayBuffer>);
      this.progress.set(Math.min(99, Math.floor(received * 100 / model.sizeBytes)));
    }
    const archive = new Blob(chunks, { type: "application/gzip" });
    await this.validateArchive(model, archive);
    await this.cacheModel(model, archive);
    return archive;
  }

  private async readCachedModel(model: VoskBrowserModel): Promise<Blob | null> {
    if (typeof caches === "undefined") return null;
    try {
      const cache = await caches.open(MODEL_CACHE);
      const response = await cache.match(this.cacheRequest(model));
      if (!response) return null;
      const archive = await response.blob();
      await this.validateArchive(model, archive);
      return archive;
    } catch {
      return null;
    }
  }

  private async cacheModel(model: VoskBrowserModel, archive: Blob): Promise<void> {
    if (typeof caches === "undefined") return;
    try {
      const cache = await caches.open(MODEL_CACHE);
      await cache.put(this.cacheRequest(model), new Response(archive, {
        headers: {
          "content-length": String(archive.size),
          "content-type": "application/gzip",
          "x-vosk-source-revision": model.sourceUrl.split("/")[5] || "",
        },
      }));
      await this.refreshCachedModels();
    } catch {
      // Quota and private-mode failures must not invalidate the already downloaded model.
    }
  }

  private async validateArchive(model: VoskBrowserModel, archive: Blob): Promise<void> {
    if (archive.size !== model.sizeBytes) throw new Error("Die Modellgröße stimmt nicht mit dem festgelegten Katalog überein.");
    const magic = new Uint8Array(await archive.slice(0, 2).arrayBuffer());
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) throw new Error("Das geladene Modell ist kein gültiges gzip-Archiv.");
  }

  private cacheRequest(model: VoskBrowserModel): Request {
    return new Request(`${location.origin}/__vosk-model-cache/${encodeURIComponent(model.id)}`);
  }

  private releaseLoadedModel(): void {
    this.loadedModel?.terminate();
    this.loadedModel = null;
    this.loadedModelId.set("");
  }
}
