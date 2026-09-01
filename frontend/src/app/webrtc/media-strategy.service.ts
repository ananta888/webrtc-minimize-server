import { Injectable, computed, signal } from "@angular/core";

import {
  MediaSource,
  OptimizationMode,
  QualitySettings,
} from "./media-optimization-policy";

export type AudioQualityProfile = "speech-low" | "speech-clear" | "music";
export type MediaPrioritySource = "microphone" | "screen" | "camera";
export type StandardMediaStrategyPreset =
  | "conversation"
  | "presentation"
  | "balanced"
  | "camera-focus"
  | "data-saver"
  | "studio";
export type MediaStrategyPreset = StandardMediaStrategyPreset | "custom";

export interface MediaStrategy {
  readonly version: 1;
  readonly presetId: MediaStrategyPreset;
  readonly audioProfile: AudioQualityProfile;
  readonly optimizationMode: OptimizationMode;
  readonly priorityOrder: readonly [MediaPrioritySource, MediaPrioritySource, MediaPrioritySource];
}

export interface AppliedAudioSettings {
  readonly sampleRate: number | null;
  readonly sampleSize: number | null;
  readonly channelCount: number | null;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
}

export interface RtpSenderMediaPolicy {
  readonly priority: RTCPriorityType;
  readonly maxBitrate: number;
}

export interface MediaStrategyOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly description: string;
}

export const MEDIA_STRATEGY_STORAGE_KEY = "webrtc-media-strategy-v1";

export const MEDIA_PRIORITY_SOURCES: readonly MediaPrioritySource[] = Object.freeze([
  "microphone",
  "screen",
  "camera",
]);

export const MEDIA_PRIORITY_OPTIONS: readonly MediaStrategyOption<MediaPrioritySource>[] = Object.freeze([
  Object.freeze({ id: "microphone", label: "Mikrofon", description: "Gespräch und Sprache" }),
  Object.freeze({ id: "screen", label: "Bildschirm", description: "Bild und optionaler Bildschirmton" }),
  Object.freeze({ id: "camera", label: "Kamera", description: "Eigenes Kameravideo" }),
]);

export const AUDIO_QUALITY_OPTIONS: readonly MediaStrategyOption<AudioQualityProfile>[] = Object.freeze([
  Object.freeze({
    id: "speech-low",
    label: "Sprache · sparsam",
    description: "Mono, 24 kbit/s Senderlimit und Sprachfilter; für knappe Uploads.",
  }),
  Object.freeze({
    id: "speech-clear",
    label: "Sprache · klar",
    description: "Mono, 48 kbit/s Senderlimit und Echo-/Rauschfilter; sicherer Standard.",
  }),
  Object.freeze({
    id: "music",
    label: "Musik · Stereo",
    description: "Stereo und 128 kbit/s ohne Sprachfilter; nur mit Kopfhörern empfohlen.",
  }),
]);

export const MEDIA_STRATEGY_OPTIONS: readonly MediaStrategyOption<MediaStrategyPreset>[] = Object.freeze([
  Object.freeze({ id: "conversation", label: "Gespräch", description: "Mikrofon vor Kamera und Bildschirm; klare Sprache und automatische Videoanpassung." }),
  Object.freeze({ id: "presentation", label: "Präsentation", description: "Bildschirm vor Mikrofon und Kamera; Text bleibt bei Engpässen möglichst lesbar." }),
  Object.freeze({ id: "balanced", label: "Ausgewogen", description: "Mikrofon vor Bildschirm und Kamera; alle Kameras bleiben als Vorschau sichtbar." }),
  Object.freeze({ id: "camera-focus", label: "Kamera-Fokus", description: "Kamera vor Mikrofon und Bildschirm; für bewegtes Bild bei gutem Upload." }),
  Object.freeze({ id: "data-saver", label: "Datensparen", description: "Sprache zuerst, 24 kbit/s Audio und stark reduzierte inaktive Videos." }),
  Object.freeze({ id: "studio", label: "Musik / Studio", description: "Stereo-Audio ohne Sprachfilter; Kamera folgt an zweiter Stelle." }),
  Object.freeze({ id: "custom", label: "Benutzerdefiniert", description: "Eigene Audio-, Video- und Prioritätseinstellungen." }),
]);

const PRESETS: Readonly<Record<StandardMediaStrategyPreset, MediaStrategy>> = Object.freeze({
  conversation: freezeStrategy("conversation", "speech-clear", "auto", ["microphone", "camera", "screen"]),
  presentation: freezeStrategy("presentation", "speech-clear", "auto", ["screen", "microphone", "camera"]),
  balanced: freezeStrategy("balanced", "speech-clear", "balanced", ["microphone", "screen", "camera"]),
  "camera-focus": freezeStrategy("camera-focus", "speech-clear", "auto", ["camera", "microphone", "screen"]),
  "data-saver": freezeStrategy("data-saver", "speech-low", "data-saver", ["microphone", "screen", "camera"]),
  studio: freezeStrategy("studio", "music", "balanced", ["microphone", "camera", "screen"]),
});

const DEFAULT_STRATEGY = PRESETS.conversation;
const RTP_PRIORITIES: readonly RTCPriorityType[] = Object.freeze(["high", "medium", "low"]);
const VIDEO_BITRATE_FACTORS: readonly number[] = Object.freeze([1, 0.72, 0.45]);

function freezeStrategy(
  presetId: MediaStrategyPreset,
  audioProfile: AudioQualityProfile,
  optimizationMode: OptimizationMode,
  priorityOrder: readonly MediaPrioritySource[],
): MediaStrategy {
  return Object.freeze({
    version: 1,
    presetId,
    audioProfile,
    optimizationMode,
    priorityOrder: Object.freeze([...priorityOrder]) as unknown as MediaStrategy["priorityOrder"],
  });
}

function isAudioProfile(value: unknown): value is AudioQualityProfile {
  return value === "speech-low" || value === "speech-clear" || value === "music";
}

function isOptimizationMode(value: unknown): value is OptimizationMode {
  return value === "auto" || value === "balanced" || value === "data-saver";
}

function isPrioritySource(value: unknown): value is MediaPrioritySource {
  return MEDIA_PRIORITY_SOURCES.includes(value as MediaPrioritySource);
}

function isStandardPreset(value: unknown): value is StandardMediaStrategyPreset {
  return typeof value === "string" && Object.hasOwn(PRESETS, value);
}

function normalizePriorityOrder(value: unknown): MediaStrategy["priorityOrder"] {
  const candidates = Array.isArray(value) ? value : [];
  const unique = candidates.filter(isPrioritySource).filter((source, index, all) => all.indexOf(source) === index);
  for (const source of MEDIA_PRIORITY_SOURCES) {
    if (!unique.includes(source)) unique.push(source);
  }
  return Object.freeze(unique.slice(0, 3)) as unknown as MediaStrategy["priorityOrder"];
}

export function parseMediaStrategy(value: string | null): MediaStrategy {
  if (!value) return DEFAULT_STRATEGY;
  try {
    const candidate = JSON.parse(value) as Partial<MediaStrategy>;
    if (candidate.version !== 1) return DEFAULT_STRATEGY;
    if (isStandardPreset(candidate.presetId)) return PRESETS[candidate.presetId];
    if (candidate.presetId !== "custom") return DEFAULT_STRATEGY;
    return freezeStrategy(
      "custom",
      isAudioProfile(candidate.audioProfile) ? candidate.audioProfile : DEFAULT_STRATEGY.audioProfile,
      isOptimizationMode(candidate.optimizationMode) ? candidate.optimizationMode : DEFAULT_STRATEGY.optimizationMode,
      normalizePriorityOrder(candidate.priorityOrder),
    );
  } catch {
    return DEFAULT_STRATEGY;
  }
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function normalizeAppliedAudioSettings(settings: MediaTrackSettings): AppliedAudioSettings {
  return Object.freeze({
    sampleRate: finitePositiveInteger(settings.sampleRate),
    sampleSize: finitePositiveInteger(settings.sampleSize),
    channelCount: finitePositiveInteger(settings.channelCount),
    echoCancellation: optionalBoolean(settings.echoCancellation),
    noiseSuppression: optionalBoolean(settings.noiseSuppression),
    autoGainControl: optionalBoolean(settings.autoGainControl),
  });
}

function onOff(value: boolean): string {
  return value ? "an" : "aus";
}

export function appliedAudioSettingsLabel(settings: AppliedAudioSettings | null): string {
  if (!settings) return "Nicht aktiv";
  const parts: string[] = [];
  if (settings.sampleRate) {
    parts.push(settings.sampleRate % 1_000 === 0 ? `${settings.sampleRate / 1_000} kHz` : `${settings.sampleRate} Hz`);
  }
  if (settings.channelCount) parts.push(`${settings.channelCount} ${settings.channelCount === 1 ? "Kanal" : "Kanäle"}`);
  if (settings.sampleSize) parts.push(`${settings.sampleSize} Bit`);
  if (settings.echoCancellation !== null) parts.push(`Echo ${onOff(settings.echoCancellation)}`);
  if (settings.noiseSuppression !== null) parts.push(`Rauschfilter ${onOff(settings.noiseSuppression)}`);
  if (settings.autoGainControl !== null) parts.push(`Pegelautomatik ${onOff(settings.autoGainControl)}`);
  return parts.length > 0 ? parts.join(" · ") : "Aktiv · Browser meldet keine Details";
}

export function prioritySourceForMedia(source: MediaSource): MediaPrioritySource {
  if (source === "microphone") return "microphone";
  if (source === "screen" || source === "screen-audio") return "screen";
  return "camera";
}

@Injectable({ providedIn: "root" })
export class MediaStrategyService {
  readonly presetOptions = MEDIA_STRATEGY_OPTIONS;
  readonly audioOptions = AUDIO_QUALITY_OPTIONS;
  readonly priorityOptions = MEDIA_PRIORITY_OPTIONS;
  private readonly state = signal<MediaStrategy>(this.load());
  private readonly appliedAudio = signal<AppliedAudioSettings | null>(null);
  readonly value = this.state.asReadonly();
  readonly presetId = computed(() => this.state().presetId);
  readonly audioProfile = computed(() => this.state().audioProfile);
  readonly optimizationMode = computed(() => this.state().optimizationMode);
  readonly priorityOrder = computed(() => this.state().priorityOrder);
  readonly presetDescription = computed(() => (
    MEDIA_STRATEGY_OPTIONS.find((option) => option.id === this.state().presetId)?.description
    || MEDIA_STRATEGY_OPTIONS.at(-1)!.description
  ));
  readonly audioDescription = computed(() => (
    AUDIO_QUALITY_OPTIONS.find((option) => option.id === this.state().audioProfile)?.description || ""
  ));
  readonly appliedAudioLabel = computed(() => appliedAudioSettingsLabel(this.appliedAudio()));

  selectPreset(value: unknown): void {
    if (isStandardPreset(value)) {
      this.store(PRESETS[value]);
      return;
    }
    if (value === "custom") this.store(freezeStrategy(
      "custom",
      this.state().audioProfile,
      this.state().optimizationMode,
      this.state().priorityOrder,
    ));
  }

  setAudioProfile(value: unknown): void {
    if (!isAudioProfile(value)) return;
    this.storeCustom({ audioProfile: value });
  }

  setOptimizationMode(value: unknown): void {
    if (!isOptimizationMode(value)) return;
    this.storeCustom({ optimizationMode: value });
  }

  setPriorityAt(index: number, value: unknown): void {
    if (!Number.isInteger(index) || index < 0 || index > 2 || !isPrioritySource(value)) return;
    const order = [...this.state().priorityOrder];
    const currentIndex = order.indexOf(value);
    [order[index], order[currentIndex]] = [order[currentIndex], order[index]];
    this.storeCustom({ priorityOrder: normalizePriorityOrder(order) });
  }

  audioConstraints(): MediaTrackConstraints {
    switch (this.state().audioProfile) {
      case "speech-low":
        return {
          sampleRate: { ideal: 24_000 },
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
      case "music":
        return {
          sampleRate: { ideal: 48_000 },
          channelCount: { ideal: 2 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
      default:
        return {
          sampleRate: { ideal: 48_000 },
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
    }
  }

  senderPolicy(source: MediaSource): RtpSenderMediaPolicy {
    const priority = this.priority(source);
    const maxBitrate = this.state().audioProfile === "speech-low"
      ? 24_000
      : this.state().audioProfile === "music" ? 128_000 : 48_000;
    return Object.freeze({ priority, maxBitrate });
  }

  prioritizeVideo(source: MediaSource, quality: QualitySettings): QualitySettings {
    const rank = this.rank(source);
    const fpsCeiling = rank === 0 ? Number.POSITIVE_INFINITY : rank === 1
      ? (source === "screen" ? 18 : 15)
      : (source === "screen" ? 10 : 8);
    return Object.freeze({
      ...quality,
      maxBitrate: quality.active ? Math.max(1, Math.round(quality.maxBitrate * VIDEO_BITRATE_FACTORS[rank])) : 0,
      maxFramerate: quality.active ? Math.min(quality.maxFramerate, fpsCeiling) : quality.maxFramerate,
    });
  }

  priority(source: MediaSource): RTCPriorityType {
    return RTP_PRIORITIES[this.rank(source)];
  }

  recordAppliedAudio(settings: MediaTrackSettings): void {
    this.appliedAudio.set(normalizeAppliedAudioSettings(settings));
  }

  clearAppliedAudio(): void {
    this.appliedAudio.set(null);
  }

  private rank(source: MediaSource): number {
    const rank = this.state().priorityOrder.indexOf(prioritySourceForMedia(source));
    return rank >= 0 ? rank : 2;
  }

  private storeCustom(changes: Partial<Pick<MediaStrategy, "audioProfile" | "optimizationMode" | "priorityOrder">>): void {
    const current = this.state();
    this.store(freezeStrategy(
      "custom",
      changes.audioProfile || current.audioProfile,
      changes.optimizationMode || current.optimizationMode,
      changes.priorityOrder || current.priorityOrder,
    ));
  }

  private store(next: MediaStrategy): void {
    this.state.set(next);
    try {
      localStorage.setItem(MEDIA_STRATEGY_STORAGE_KEY, JSON.stringify(next));
      sessionStorage.setItem("webrtc-optimization-mode", next.optimizationMode);
    } catch {
      // Hardened/private contexts may reject storage; the in-memory strategy remains fully usable.
    }
  }

  private load(): MediaStrategy {
    try {
      const stored = localStorage.getItem(MEDIA_STRATEGY_STORAGE_KEY);
      if (stored) return parseMediaStrategy(stored);
      const legacyMode = sessionStorage.getItem("webrtc-optimization-mode");
      if (legacyMode === "balanced") return PRESETS.balanced;
      if (legacyMode === "data-saver") return PRESETS["data-saver"];
    } catch {
      // Storage is optional; use the safe conversation preset below.
    }
    return DEFAULT_STRATEGY;
  }
}
