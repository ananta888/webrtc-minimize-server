export type BroadcastCaptionStyle = "high-contrast" | "subtle" | "large";
export type BroadcastCaptionSpeakerMode = "off" | "custom";
export type BroadcastCaptionDiscontinuityReason =
  | "source-change"
  | "pause"
  | "resume"
  | "handoff"
  | "player-resync"
  | "revoke";

export interface BroadcastCaptionConsent {
  readonly policyVersion: 1;
  readonly localOverlay: boolean;
  readonly shareWithRoom: boolean;
  readonly broadcastTextTrack: boolean;
  readonly broadcastBurnIn: boolean;
}

export interface BroadcastCaptionSettings {
  readonly settingsVersion: 1;
  readonly modelId: string;
  readonly language: string;
  readonly speakerMode: BroadcastCaptionSpeakerMode;
  readonly speakerLabel: string;
  readonly delayMs: number;
  readonly maximumLineLength: number;
  readonly positionPercent: number;
  readonly style: BroadcastCaptionStyle;
  readonly syncBudgetMs: number;
}

export interface BroadcastCaptionInput {
  readonly sourceId: string;
  readonly sourceEpoch: number;
  readonly utteranceId: string;
  readonly revision: number;
  readonly language: string;
  readonly text: string;
  readonly final: boolean;
  readonly capturedAtMs: number;
}

export interface BroadcastCaptionCue {
  readonly cueId: string;
  readonly sourceId: string;
  readonly sourceEpoch: number;
  readonly discontinuitySequence: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly language: string;
  readonly lines: readonly string[];
  readonly positionPercent: number;
  readonly style: BroadcastCaptionStyle;
}

export interface BroadcastCaptionSegment {
  readonly format: "webvtt";
  readonly language: string;
  readonly mediaSequence: number;
  readonly discontinuitySequence: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly cueCount: number;
  readonly body: string;
}

export interface BroadcastCaptionResult {
  readonly accepted: boolean;
  readonly reason:
    | "accepted-partial"
    | "accepted-final"
    | "not-shared"
    | "source-not-authorized"
    | "invalid-caption"
    | "stale-caption"
    | "capacity-exceeded"
    | "duplicate-revision";
  readonly transientText: string;
  readonly cue?: BroadcastCaptionCue;
  readonly segment?: BroadcastCaptionSegment;
}

export interface BroadcastCaptionOutputPort {
  setBurnIn(text: string, style: BroadcastCaptionStyle, positionPercent: number): void;
  clearBurnIn(): void;
  publishTextTrack(segment: BroadcastCaptionSegment): void;
  revokeTextTrack(discontinuitySequence: number): void;
}

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{2,79}$/;

export const DEFAULT_BROADCAST_CAPTION_CONSENT: BroadcastCaptionConsent = Object.freeze({
  policyVersion: 1,
  localOverlay: false,
  shareWithRoom: false,
  broadcastTextTrack: false,
  broadcastBurnIn: false,
});

export const DEFAULT_BROADCAST_CAPTION_SETTINGS: BroadcastCaptionSettings = Object.freeze({
  settingsVersion: 1,
  modelId: "de-de-small-0.15",
  language: "de-DE",
  speakerMode: "off",
  speakerLabel: "",
  delayMs: 600,
  maximumLineLength: 42,
  positionPercent: 88,
  style: "high-contrast",
  syncBudgetMs: 3_000,
});

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function boundedLabel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeBroadcastCaptionConsent(value: BroadcastCaptionConsent): BroadcastCaptionConsent | null {
  if (!value || value.policyVersion !== 1
    || typeof value.localOverlay !== "boolean"
    || typeof value.shareWithRoom !== "boolean"
    || typeof value.broadcastTextTrack !== "boolean"
    || typeof value.broadcastBurnIn !== "boolean") return null;
  return Object.freeze({ ...value });
}

export function normalizeBroadcastCaptionSettings(value: BroadcastCaptionSettings): BroadcastCaptionSettings | null {
  if (!value || value.settingsVersion !== 1 || !MODEL_ID.test(value.modelId)
    || !LANGUAGE.test(value.language)
    || (value.speakerMode !== "off" && value.speakerMode !== "custom")
    || !boundedLabel(value.speakerLabel)
    || (value.speakerMode === "custom" && value.speakerLabel.trim().length < 1)
    || !integerInRange(value.delayMs, 0, 5_000)
    || !integerInRange(value.maximumLineLength, 20, 80)
    || !integerInRange(value.positionPercent, 10, 95)
    || !new Set<BroadcastCaptionStyle>(["high-contrast", "subtle", "large"]).has(value.style)
    || !integerInRange(value.syncBudgetMs, 1_000, 8_000)) return null;
  return Object.freeze({ ...value, speakerLabel: value.speakerLabel.trim() });
}
