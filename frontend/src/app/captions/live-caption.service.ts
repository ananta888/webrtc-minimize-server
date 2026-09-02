import { Injectable, computed, signal } from "@angular/core";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { CaptionAudioGraph, CaptionAudioGraphFactory } from "./caption-audio-graph";
import { VoskModelManagerService } from "./vosk-model-manager.service";
import { VoskRecognizerPort } from "./vosk-runtime-adapter";

const PARTIAL_SEND_INTERVAL_MS = 250;

function storedOverlayPreference(): boolean {
  try { return localStorage.getItem("webrtc-caption-overlay-v1") !== "false"; } catch { return true; }
}

function utteranceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class LiveCaptionService {
  readonly active = signal(false);
  readonly starting = signal(false);
  readonly error = signal("");
  readonly partialText = signal("");
  readonly showOverlay = signal(storedOverlayPreference());
  readonly entries = this.mesh.captions;
  readonly recentEntries = computed(() => this.entries().slice(-100).reverse());
  readonly overlayEntries = computed(() => this.entries().slice(-3));
  readonly supported = computed(() => this.audioGraphFactory.supported());
  private graph: CaptionAudioGraph | null = null;
  private recognizer: VoskRecognizerPort | null = null;
  private sourceTrackId = "";
  private currentUtteranceId = "";
  private revision = 0;
  private lastSentAt = 0;
  private lastSentText = "";
  private pendingPartialTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly unregisterMicrophoneListener: () => void;

  constructor(
    private readonly media: MediaPublicationService,
    private readonly mesh: PeerMeshService,
    private readonly models: VoskModelManagerService,
    private readonly audioGraphFactory: CaptionAudioGraphFactory,
  ) {
    this.unregisterMicrophoneListener = this.media.registerMicrophoneStopListener(() => this.stop());
  }

  async start(): Promise<boolean> {
    if (this.active()) return true;
    if (this.starting()) return false;
    this.error.set("");
    if (!this.models.ready()) {
      this.error.set("Bitte lade zuerst das ausgewählte Sprachmodell.");
      return false;
    }
    if (this.mesh.participantCount() < 1) {
      this.error.set("Live-Untertitel können erst in einem Raum gestartet werden.");
      return false;
    }
    const track = this.media.microphoneTrack();
    if (!track || track.readyState !== "live") {
      this.error.set("Starte zuerst bewusst dein Mikrofon. Untertitel fordern keine eigene Aufnahmefreigabe an.");
      return false;
    }
    if (!this.audioGraphFactory.supported()) {
      this.error.set("Dieser Browser unterstützt den benötigten AudioWorklet-Pfad nicht.");
      return false;
    }
    const generation = ++this.generation;
    this.starting.set(true);
    this.sourceTrackId = track.id;
    let graph: CaptionAudioGraph | null = null;
    let recognizer: VoskRecognizerPort | null = null;
    try {
      graph = await this.audioGraphFactory.connect(track, (samples, sampleRate) => {
        if (!this.active() || !this.recognizer || generation !== this.generation) return;
        try {
          this.recognizer.acceptWaveformFloat(samples, sampleRate);
        } catch (error) {
          this.fail(error instanceof Error ? error.message : "Vosk konnte den Audioblock nicht verarbeiten.");
        }
      });
      if (generation !== this.generation || this.media.microphoneTrack()?.id !== this.sourceTrackId) {
        await graph.close();
        return false;
      }
      recognizer = this.models.createRecognizer(graph.sampleRate);
      recognizer.on("partialresult", (message) => this.acceptRecognition(message.result?.partial || "", false));
      recognizer.on("result", (message) => this.acceptRecognition(message.result?.text || "", true));
      recognizer.on("error", (message) => this.fail(message.error || "Vosk-Erkennung ist fehlgeschlagen."));
      this.graph = graph;
      this.recognizer = recognizer;
      this.active.set(true);
      return true;
    } catch (error) {
      recognizer?.remove();
      if (graph) await graph.close();
      if (generation === this.generation) {
        this.error.set(error instanceof Error ? error.message : "Live-Untertitel konnten nicht gestartet werden.");
      }
      return false;
    } finally {
      if (generation === this.generation) this.starting.set(false);
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.partialText().trim() && this.currentUtteranceId) this.publish(this.partialText(), true);
    if (this.pendingPartialTimer) clearTimeout(this.pendingPartialTimer);
    this.pendingPartialTimer = null;
    this.recognizer?.remove();
    this.recognizer = null;
    const graph = this.graph;
    this.graph = null;
    if (graph) void graph.close();
    this.active.set(false);
    this.starting.set(false);
    this.partialText.set("");
    this.resetUtterance();
    this.sourceTrackId = "";
    this.models.unload();
  }

  setOverlay(enabled: unknown): void {
    const value = enabled === true;
    this.showOverlay.set(value);
    try { localStorage.setItem("webrtc-caption-overlay-v1", String(value)); } catch { /* optional preference */ }
  }

  clear(): void {
    this.mesh.clearCaptions();
    this.partialText.set("");
  }

  destroy(): void {
    this.stop();
    this.unregisterMicrophoneListener();
    this.models.destroy();
    this.mesh.clearCaptions();
  }

  private acceptRecognition(rawText: string, final: boolean): void {
    if (!this.active()) return;
    const text = rawText.trim().slice(0, 500).trim();
    if (!text) {
      if (final) {
        this.partialText.set("");
        this.resetUtterance();
      }
      return;
    }
    this.partialText.set(text);
    if (final) {
      if (this.pendingPartialTimer) clearTimeout(this.pendingPartialTimer);
      this.pendingPartialTimer = null;
      this.publish(text, true);
      this.partialText.set("");
      this.resetUtterance();
      return;
    }
    if (!this.currentUtteranceId) this.beginUtterance();
    if (text === this.lastSentText) return;
    const delay = PARTIAL_SEND_INTERVAL_MS - (Date.now() - this.lastSentAt);
    if (delay <= 0) {
      this.publish(text, false);
      return;
    }
    if (!this.pendingPartialTimer) {
      this.pendingPartialTimer = setTimeout(() => {
        this.pendingPartialTimer = null;
        if (this.active() && this.partialText() && this.partialText() !== this.lastSentText) {
          this.publish(this.partialText(), false);
        }
      }, delay);
    }
  }

  private publish(text: string, final: boolean): void {
    if (!this.currentUtteranceId) this.beginUtterance();
    const sent = this.mesh.sendCaption({
      utteranceId: this.currentUtteranceId,
      revision: this.revision,
      language: this.models.selectedModel().languageTag,
      text,
      final,
    });
    if (!sent) return;
    this.revision += 1;
    this.lastSentAt = Date.now();
    this.lastSentText = text;
  }

  private beginUtterance(): void {
    this.currentUtteranceId = utteranceId();
    this.revision = 0;
    this.lastSentAt = 0;
    this.lastSentText = "";
  }

  private resetUtterance(): void {
    this.currentUtteranceId = "";
    this.revision = 0;
    this.lastSentAt = 0;
    this.lastSentText = "";
  }

  private fail(message: string): void {
    this.error.set(message);
    this.stop();
  }
}
