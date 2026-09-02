import { MediaSource, QualitySettings, VideoTier } from "./media-optimization-policy";

export type ReceiveQualityProfile = "auto" | "low" | "medium" | "high" | "audio-only";

export interface ReceiveQualityOption {
  readonly id: ReceiveQualityProfile;
  readonly label: string;
  readonly description: string;
}

export const RECEIVE_QUALITY_OPTIONS: readonly ReceiveQualityOption[] = Object.freeze([
  Object.freeze({
    id: "auto",
    label: "Automatisch",
    description: "Active Speaker, Raumgröße und Linkwerte wählen laufend die passende Empfangsstufe.",
  }),
  Object.freeze({
    id: "low",
    label: "Niedrig · sparsam",
    description: "Kameras höchstens als 120-kbit/s-Vorschau mit 6 FPS; Bildschirm höchstens 600 kbit/s mit 5 FPS.",
  }),
  Object.freeze({
    id: "medium",
    label: "Mittel · ausgewogen",
    description: "Kameras höchstens 420 kbit/s mit 15 FPS; Bildschirm höchstens 1,2 Mbit/s mit 12 FPS.",
  }),
  Object.freeze({
    id: "high",
    label: "Hoch · bis Fokus",
    description: "Erlaubt bis zu 1,2 Mbit/s und 24 FPS je Kamera; Senderstrategie und Netz dürfen weiter reduzieren.",
  }),
  Object.freeze({
    id: "audio-only",
    label: "Nur Audio",
    description: "Pausiert Kamera und Bildschirm nur für diesen Browser; Mikrofon und Bildschirmton bleiben empfangbar.",
  }),
]);

const CAMERA_TIER_RANK: Readonly<Record<VideoTier, number>> = Object.freeze({
  paused: -1,
  thumbnail: 0,
  balanced: 1,
  focus: 2,
  screen: 2,
});

const CAMERA_CEILINGS: Readonly<Record<"low" | "medium" | "high", QualitySettings>> = Object.freeze({
  low: Object.freeze({ tier: "thumbnail", active: true, maxBitrate: 120_000, maxFramerate: 6, scaleResolutionDownBy: 4 }),
  medium: Object.freeze({ tier: "balanced", active: true, maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 2 }),
  high: Object.freeze({ tier: "focus", active: true, maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 }),
});

const SCREEN_CEILINGS: Readonly<Record<"low" | "medium" | "high", QualitySettings>> = Object.freeze({
  low: Object.freeze({ tier: "screen", active: true, maxBitrate: 600_000, maxFramerate: 5, scaleResolutionDownBy: 2 }),
  medium: Object.freeze({ tier: "screen", active: true, maxBitrate: 1_200_000, maxFramerate: 12, scaleResolutionDownBy: 1 }),
  high: Object.freeze({ tier: "screen", active: true, maxBitrate: 2_500_000, maxFramerate: 24, scaleResolutionDownBy: 1 }),
});

const PAUSED_VIDEO: QualitySettings = Object.freeze({
  tier: "paused",
  active: false,
  maxBitrate: 0,
  maxFramerate: 1,
  scaleResolutionDownBy: 8,
});

export function isReceiveQualityProfile(value: unknown): value is ReceiveQualityProfile {
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "audio-only";
}

export function capVideoQualityForReceiver(
  source: MediaSource,
  quality: QualitySettings,
  profile: ReceiveQualityProfile,
): QualitySettings {
  if (source !== "camera" && source !== "screen") return quality;
  if (profile === "auto" || !quality.active) return quality;
  if (profile === "audio-only") return PAUSED_VIDEO;
  const ceiling = source === "camera" ? CAMERA_CEILINGS[profile] : SCREEN_CEILINGS[profile];
  const tier = source === "camera" && CAMERA_TIER_RANK[quality.tier] > CAMERA_TIER_RANK[ceiling.tier]
    ? ceiling.tier : quality.tier;
  return Object.freeze({
    tier,
    active: true,
    maxBitrate: Math.min(quality.maxBitrate, ceiling.maxBitrate),
    maxFramerate: Math.min(quality.maxFramerate, ceiling.maxFramerate),
    scaleResolutionDownBy: Math.max(quality.scaleResolutionDownBy, ceiling.scaleResolutionDownBy),
  });
}

export function mediaAgentCameraLayerCeiling(
  profile: ReceiveQualityProfile,
): "low" | "medium" | "high" {
  if (profile === "low" || profile === "audio-only") return "low";
  return profile === "medium" ? "medium" : "high";
}

export function receiveVideoEnabled(profile: ReceiveQualityProfile): boolean {
  return profile !== "audio-only";
}
