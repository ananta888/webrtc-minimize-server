import { Injectable, computed, signal } from "@angular/core";

import { CaptionAudioSource } from "../webrtc/caption-contract";
import { MediaPublicationService } from "../webrtc/media-publication.service";
import { CaptionEntry, PeerMeshService } from "../webrtc/peer-mesh.service";
import { CaptionAudioGraph, CaptionAudioGraphFactory } from "./caption-audio-graph";
import { VoskModelManagerService } from "./vosk-model-manager.service";
import { VoskRecognizerPort } from "./vosk-runtime-adapter";

const PARTIAL_SEND_INTERVAL_MS = 250;
export const CAPTION_AUDIO_SOURCES: readonly CaptionAudioSource[] = Object.freeze(["microphone", "screen-audio"]);

interface CaptionPipeline {
  readonly source: CaptionAudioSource;
  readonly generation: number;
  readonly graph: CaptionAudioGraph;
  readonly recognizer: VoskRecognizerPort;
  currentUtteranceId: string;
  revision: number;
  lastSentAt: number;
  lastSentText: string;
  pendingPartialTimer: ReturnType<typeof setTimeout> | null;
  partialText: string;
}

export interface LiveCaptionEmission {
  readonly source: CaptionAudioSource;
  readonly sourceEpoch: number;
  readonly utteranceId: string;
  readonly revision: number;
  readonly language: string;
  readonly text: string;
  readonly final: boolean;
  readonly capturedAtMs: number;
}

export type LiveCaptionEmissionListener = (emission: LiveCaptionEmission) => void;
export type LiveCaptionSourceStopListener = (source: CaptionAudioSource, nextEpoch: number) => void;

export type CaptionOverlayPosition = "bottom" | "top";
export type CaptionOverlayFontSize = "small" | "medium" | "large";

function storedPosition(): CaptionOverlayPosition {
  try {
    const val = localStorage.getItem("webrtc-caption-position-v1");
    return val === "top" ? "top" : "bottom";
  } catch {
    return "bottom";
  }
}

function storedFontSize(): CaptionOverlayFontSize {
  try {
    const val = localStorage.getItem("webrtc-caption-size-v1");
    return val === "small" || val === "large" ? val : "medium";
  } catch {
    return "medium";
  }
}

function storedMaxLines(): number {
  try {
    const val = Number(localStorage.getItem("webrtc-caption-lines-v1"));
    return Number.isInteger(val) && val >= 1 && val <= 5 ? val : 3;
  } catch {
    return 3;
  }
}

function storedBoolean(key: string, defaultValue: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? defaultValue : value === "true";
  } catch {
    return defaultValue;
  }
}

function storedSource(): CaptionAudioSource {
  try {
    return localStorage.getItem("webrtc-caption-source-v1") === "screen-audio" ? "screen-audio" : "microphone";
  } catch {
    return "microphone";
  }
}

function utteranceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class LiveCaptionService {
  readonly selectedSource = signal<CaptionAudioSource>(storedSource());
  readonly activeSources = signal<readonly CaptionAudioSource[]>([]);
  readonly startingSources = signal<readonly CaptionAudioSource[]>([]);
  readonly active = computed(() => this.activeSources().length > 0);
  readonly starting = computed(() => this.startingSources().length > 0);
  readonly error = signal("");
  readonly showOverlay = signal(storedBoolean("webrtc-caption-overlay-v1", true));
  readonly overlayPosition = signal<CaptionOverlayPosition>(storedPosition());
  readonly overlayFontSize = signal<CaptionOverlayFontSize>(storedFontSize());
  readonly overlayMaxLines = signal<number>(storedMaxLines());
  readonly shareWithRoom = signal(storedBoolean("webrtc-caption-share-v1", false));
  readonly entries = this.mesh.captions;
  readonly recentEntries = computed(() => this.entries().slice(-100).reverse());
  readonly overlayEntries = computed(() => this.entries().slice(-this.overlayMaxLines()));
  readonly supported = computed(() => this.audioGraphFactory.supported());
  private readonly partialTexts = signal<Record<CaptionAudioSource, string>>({
    microphone: "",
    "screen-audio": "",
  });
  readonly partialText = computed(() => this.partialTexts()[this.selectedSource()]);
  private readonly pipelines = new Map<CaptionAudioSource, CaptionPipeline>();
  private readonly generations = new Map<CaptionAudioSource, number>();
  private readonly emissionListeners = new Set<LiveCaptionEmissionListener>();
  private readonly sourceStopListeners = new Set<LiveCaptionSourceStopListener>();
  private readonly unregisterMicrophoneListener: () => void;
  private readonly unregisterScreenAudioListener: () => void;

  constructor(
    private readonly media: MediaPublicationService,
    private readonly mesh: PeerMeshService,
    private readonly models: VoskModelManagerService,
    private readonly audioGraphFactory: CaptionAudioGraphFactory,
  ) {
    this.unregisterMicrophoneListener = this.media.registerMicrophoneStopListener(() => this.stop("microphone"));
    this.unregisterScreenAudioListener = this.media.registerScreenAudioStopListener(() => this.stop("screen-audio"));
  }

  selectSource(value: unknown): boolean {
    if (value !== "microphone" && value !== "screen-audio") return false;
    this.selectedSource.set(value);
    try { localStorage.setItem("webrtc-caption-source-v1", value); } catch { /* optional preference */ }
    return true;
  }

  setShareWithRoom(value: unknown): boolean {
    if (this.active() || this.starting()) return false;
    const enabled = value === true;
    this.shareWithRoom.set(enabled);
    try { localStorage.setItem("webrtc-caption-share-v1", String(enabled)); } catch { /* optional preference */ }
    return true;
  }

  setOverlay(enabled: unknown): void {
    const value = enabled === true;
    this.showOverlay.set(value);
    try { localStorage.setItem("webrtc-caption-overlay-v1", String(value)); } catch { /* optional preference */ }
  }

  setOverlayPosition(position: unknown): boolean {
    if (position !== "bottom" && position !== "top") return false;
    this.overlayPosition.set(position);
    try { localStorage.setItem("webrtc-caption-position-v1", position); } catch { /* best-effort */ }
    return true;
  }

  setOverlayFontSize(size: unknown): boolean {
    if (size !== "small" && size !== "medium" && size !== "large") return false;
    this.overlayFontSize.set(size);
    try { localStorage.setItem("webrtc-caption-size-v1", size); } catch { /* best-effort */ }
    return true;
  }

  setOverlayMaxLines(lines: unknown): boolean {
    const count = Number(lines);
    if (!Number.isInteger(count) || count < 1 || count > 5) return false;
    this.overlayMaxLines.set(count);
    try { localStorage.setItem("webrtc-caption-lines-v1", String(count)); } catch { /* best-effort */ }
    return true;
  }

  resetOverlaySettings(): void {
    this.setOverlayPosition("bottom");
    this.setOverlayFontSize("medium");
    this.setOverlayMaxLines(3);
  }

  formatTranscriptText(): string;
  formatTranscriptText(entriesToFormat?: readonly CaptionEntry[]): string;
  formatTranscriptText(entriesToFormat?: readonly CaptionEntry[]): string {
    const entries = entriesToFormat ?? this.entries();
    if (entries.length === 0) return "";
    const header = [
      "# webrtc-minimize-server Untertitel-Transkript",
      `# Exportiert am: ${new Date().toISOString()}`,
      "# Datenschutzhinweis: Nur mit Zustimmung aller Gesprächsteilnehmer verwenden.",
      "",
    ];
    const body = entries.map((entry) => {
      const time = new Date(entry.receivedAt).toTimeString().split(" ")[0];
      const speaker = entry.local ? "Du" : entry.author;
      const status = entry.final ? "" : " [unvollständig]";
      return `[${time}] ${speaker} (${entry.source}, ${entry.language}): ${entry.text}${status}`;
    });
    return [...header, ...body].join("\n");
  }

  downloadTranscript(): boolean;
  downloadTranscript(customEntries?: readonly CaptionEntry[]): boolean;
  downloadTranscript(customEntries?: readonly CaptionEntry[]): boolean {
    const text = this.formatTranscriptText(customEntries);
    if (!text) return false;
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `webrtc-transkript-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  }

  sourceAvailable(source: CaptionAudioSource): boolean {
    const track = this.sourceTrack(source);
    return Boolean(track && track.readyState === "live");
  }

  isSourceActive(source: CaptionAudioSource): boolean {
    return this.pipelines.has(source);
  }

  isSourceStarting(source: CaptionAudioSource): boolean {
    return this.startingSources().includes(source);
  }

  async start(source: CaptionAudioSource = this.selectedSource()): Promise<boolean> {
    if (this.isSourceActive(source)) return true;
    if (this.isSourceStarting(source)) return false;
    this.error.set("");
    if (!this.models.ready()) {
      this.error.set("Bitte lade zuerst das ausgewählte Sprachmodell.");
      return false;
    }
    if (this.mesh.participantCount() < 1) {
      this.error.set("Live-Untertitel können erst in einem Raum gestartet werden.");
      return false;
    }
    const track = this.sourceTrack(source);
    if (!track || track.readyState !== "live") {
      this.error.set(source === "microphone"
        ? "Starte zuerst bewusst dein Mikrofon. Untertitel fordern keine eigene Aufnahmefreigabe an."
        : "Teile zuerst bewusst einen Bildschirm oder Tab mit Ton. Untertitel fordern keine eigene Bildschirmfreigabe an.");
      return false;
    }
    if (!this.audioGraphFactory.supported()) {
      this.error.set("Dieser Browser unterstützt den benötigten AudioWorklet-Pfad nicht.");
      return false;
    }
    const generation = this.nextGeneration(source);
    const sourceTrackId = track.id;
    this.updateSourceSignal(this.startingSources, source, true);
    let graph: CaptionAudioGraph | null = null;
    let recognizer: VoskRecognizerPort | null = null;
    try {
      graph = await this.audioGraphFactory.connect(track, (samples, sampleRate) => {
        const pipeline = this.pipelines.get(source);
        if (!pipeline || pipeline.generation !== generation) return;
        try {
          pipeline.recognizer.acceptWaveformFloat(samples, sampleRate);
        } catch (error) {
          this.fail(source, error instanceof Error ? error.message : "Vosk konnte den Audioblock nicht verarbeiten.");
        }
      });
      if (generation !== this.currentGeneration(source) || this.sourceTrack(source)?.id !== sourceTrackId) {
        await graph.close();
        return false;
      }
      recognizer = this.models.createRecognizer(graph.sampleRate);
      const pipeline: CaptionPipeline = {
        source,
        generation,
        graph,
        recognizer,
        currentUtteranceId: "",
        revision: 0,
        lastSentAt: 0,
        lastSentText: "",
        pendingPartialTimer: null,
        partialText: "",
      };
      recognizer.on("partialresult", (message) => this.acceptRecognition(pipeline, message.result?.partial || "", false));
      recognizer.on("result", (message) => this.acceptRecognition(pipeline, message.result?.text || "", true));
      recognizer.on("error", (message) => this.fail(source, message.error || "Vosk-Erkennung ist fehlgeschlagen."));
      this.pipelines.set(source, pipeline);
      this.updateSourceSignal(this.activeSources, source, true);
      return true;
    } catch (error) {
      recognizer?.remove();
      if (graph) await graph.close();
      if (generation === this.currentGeneration(source)) {
        this.error.set(error instanceof Error ? error.message : "Live-Untertitel konnten nicht gestartet werden.");
      }
      return false;
    } finally {
      if (generation === this.currentGeneration(source)) {
        this.updateSourceSignal(this.startingSources, source, false);
        this.releaseModelIfIdle();
      }
    }
  }

  stop(source?: CaptionAudioSource): void {
    if (source) {
      this.stopSource(source);
      this.releaseModelIfIdle();
      return;
    }
    for (const item of CAPTION_AUDIO_SOURCES) this.stopSource(item);
    this.models.unload();
  }

  clear(): void {
    this.mesh.clearCaptions();
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.pendingPartialTimer) clearTimeout(pipeline.pendingPartialTimer);
      pipeline.pendingPartialTimer = null;
      pipeline.partialText = "";
      this.resetUtterance(pipeline);
    }
    this.partialTexts.set({ microphone: "", "screen-audio": "" });
  }

  registerEmissionListener(listener: LiveCaptionEmissionListener): () => void {
    this.emissionListeners.add(listener);
    return () => this.emissionListeners.delete(listener);
  }

  registerSourceStopListener(listener: LiveCaptionSourceStopListener): () => void {
    this.sourceStopListeners.add(listener);
    return () => this.sourceStopListeners.delete(listener);
  }

  destroy(): void {
    this.stop();
    this.unregisterMicrophoneListener();
    this.unregisterScreenAudioListener();
    this.models.destroy();
    this.mesh.clearCaptions();
    this.emissionListeners.clear();
    this.sourceStopListeners.clear();
  }

  private stopSource(source: CaptionAudioSource): void {
    const nextEpoch = this.nextGeneration(source);
    for (const listener of this.sourceStopListeners) {
      try { listener(source, nextEpoch); } catch { /* Optional consumers cannot prevent local cleanup. */ }
    }
    this.updateSourceSignal(this.startingSources, source, false);
    const pipeline = this.pipelines.get(source);
    if (!pipeline) {
      this.setPartialText(source, "");
      return;
    }
    if (pipeline.partialText.trim() && pipeline.currentUtteranceId) this.publish(pipeline, pipeline.partialText, true);
    if (pipeline.pendingPartialTimer) clearTimeout(pipeline.pendingPartialTimer);
    pipeline.pendingPartialTimer = null;
    pipeline.recognizer.remove();
    this.pipelines.delete(source);
    void pipeline.graph.close();
    this.updateSourceSignal(this.activeSources, source, false);
    this.setPartialText(source, "");
    this.resetUtterance(pipeline);
  }

  private acceptRecognition(pipeline: CaptionPipeline, rawText: string, final: boolean): void {
    if (this.pipelines.get(pipeline.source) !== pipeline) return;
    const text = rawText.trim().slice(0, 500).trim();
    if (!text) {
      if (final) {
        pipeline.partialText = "";
        this.setPartialText(pipeline.source, "");
        this.resetUtterance(pipeline);
      }
      return;
    }
    pipeline.partialText = text;
    this.setPartialText(pipeline.source, text);
    if (final) {
      if (pipeline.pendingPartialTimer) clearTimeout(pipeline.pendingPartialTimer);
      pipeline.pendingPartialTimer = null;
      this.publish(pipeline, text, true);
      pipeline.partialText = "";
      this.setPartialText(pipeline.source, "");
      this.resetUtterance(pipeline);
      return;
    }
    if (!pipeline.currentUtteranceId) this.beginUtterance(pipeline);
    if (text === pipeline.lastSentText) return;
    const delay = PARTIAL_SEND_INTERVAL_MS - (Date.now() - pipeline.lastSentAt);
    if (delay <= 0) {
      this.publish(pipeline, text, false);
      return;
    }
    if (!pipeline.pendingPartialTimer) {
      pipeline.pendingPartialTimer = setTimeout(() => {
        pipeline.pendingPartialTimer = null;
        if (this.pipelines.get(pipeline.source) === pipeline
          && pipeline.partialText && pipeline.partialText !== pipeline.lastSentText) {
          this.publish(pipeline, pipeline.partialText, false);
        }
      }, delay);
    }
  }

  private publish(pipeline: CaptionPipeline, text: string, final: boolean): void {
    if (!pipeline.currentUtteranceId) this.beginUtterance(pipeline);
    const emission = Object.freeze({
      source: pipeline.source,
      sourceEpoch: pipeline.generation,
      utteranceId: pipeline.currentUtteranceId,
      revision: pipeline.revision,
      language: this.models.selectedModel().languageTag,
      text,
      final,
      capturedAtMs: Date.now(),
    });
    const sent = this.mesh.sendCaption({
      utteranceId: emission.utteranceId,
      revision: emission.revision,
      language: emission.language,
      text: emission.text,
      final: emission.final,
      source: emission.source,
    }, this.shareWithRoom());
    if (!sent) return;
    for (const listener of this.emissionListeners) {
      try { listener(emission); } catch { /* An optional local consumer cannot stop recognition. */ }
    }
    pipeline.revision += 1;
    pipeline.lastSentAt = Date.now();
    pipeline.lastSentText = text;
  }

  private beginUtterance(pipeline: CaptionPipeline): void {
    pipeline.currentUtteranceId = utteranceId();
    pipeline.revision = 0;
    pipeline.lastSentAt = 0;
    pipeline.lastSentText = "";
  }

  private resetUtterance(pipeline: CaptionPipeline): void {
    pipeline.currentUtteranceId = "";
    pipeline.revision = 0;
    pipeline.lastSentAt = 0;
    pipeline.lastSentText = "";
  }

  private sourceTrack(source: CaptionAudioSource): MediaStreamTrack | null {
    return source === "microphone" ? this.media.microphoneTrack() : this.media.screenAudioTrack();
  }

  private fail(source: CaptionAudioSource, message: string): void {
    this.error.set(message);
    this.stop(source);
  }

  private nextGeneration(source: CaptionAudioSource): number {
    const generation = (this.generations.get(source) || 0) + 1;
    this.generations.set(source, generation);
    return generation;
  }

  private currentGeneration(source: CaptionAudioSource): number {
    return this.generations.get(source) || 0;
  }

  private setPartialText(source: CaptionAudioSource, text: string): void {
    this.partialTexts.update((current) => ({ ...current, [source]: text }));
  }

  private updateSourceSignal(
    target: { (): readonly CaptionAudioSource[]; set(value: readonly CaptionAudioSource[]): void },
    source: CaptionAudioSource,
    enabled: boolean,
  ): void {
    const active = new Set(target());
    if (enabled) active.add(source); else active.delete(source);
    target.set(CAPTION_AUDIO_SOURCES.filter((item) => active.has(item)));
  }

  private releaseModelIfIdle(): void {
    if (this.pipelines.size === 0 && this.startingSources().length === 0) this.models.unload();
  }
}
