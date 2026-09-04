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

const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const UTTERANCE_ID = /^[a-f0-9]{16}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{2,79}$/;
const MAX_CAPTION_TEXT = 500;
const MAX_CUES = 32;
const MAX_SEGMENT_BYTES = 64 * 1024;
const LIVE_WINDOW_MS = 30_000;

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

function normalizeCaptionText(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CAPTION_TEXT
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return null;
  const normalized = value.trim().replace(/\s+/g, " ").replace(/-->/g, "→");
  return normalized.length > 0 && normalized.length <= MAX_CAPTION_TEXT ? normalized : null;
}

function wrapText(text: string, maximum: number): readonly string[] {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > maximum) lines.push(word.slice(0, maximum));
    else lines[lines.length - 1] = `${current} ${word}`;
    if (lines.length === 3) break;
  }
  return Object.freeze(lines);
}

function webVttTime(milliseconds: number): string {
  const bounded = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(bounded / 3_600_000);
  const minutes = Math.floor((bounded % 3_600_000) / 60_000);
  const seconds = Math.floor((bounded % 60_000) / 1_000);
  const millis = bounded % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function cueText(cue: BroadcastCaptionCue): string {
  return `${cue.cueId}\n${webVttTime(cue.startMs)} --> ${webVttTime(cue.endMs)} position:50% line:${cue.positionPercent}% align:middle\n${cue.lines.join("\n")}`;
}

export class BrowserBroadcastCaptionPackager {
  private readonly revisions = new Map<string, number>();
  private readonly authorizedSources = new Map<string, number>();
  private cues: BroadcastCaptionCue[] = [];
  private programStartedAtMs = 0;
  private mediaSequence = 0;
  private discontinuitySequence = 0;
  private consent = DEFAULT_BROADCAST_CAPTION_CONSENT;
  private settings = DEFAULT_BROADCAST_CAPTION_SETTINGS;

  constructor(private readonly output: BroadcastCaptionOutputPort) {}

  begin(programStartedAtMs: number, consent: BroadcastCaptionConsent, settings: BroadcastCaptionSettings): boolean {
    const normalizedConsent = normalizeBroadcastCaptionConsent(consent);
    const normalizedSettings = normalizeBroadcastCaptionSettings(settings);
    if (!Number.isSafeInteger(programStartedAtMs) || programStartedAtMs < 0 || !normalizedConsent || !normalizedSettings) return false;
    this.clearOutputs();
    this.programStartedAtMs = programStartedAtMs;
    this.consent = normalizedConsent;
    this.settings = normalizedSettings;
    return true;
  }

  authorizeSource(sourceId: string, sourceEpoch: number): boolean {
    if (!SOURCE_ID.test(sourceId) || !Number.isSafeInteger(sourceEpoch) || sourceEpoch < 1) return false;
    this.authorizedSources.set(sourceId, sourceEpoch);
    return true;
  }

  ingest(input: BroadcastCaptionInput, nowMs: number): BroadcastCaptionResult {
    const text = normalizeCaptionText(input?.text);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !input || !SOURCE_ID.test(input.sourceId)
      || !UTTERANCE_ID.test(input.utteranceId) || !integerInRange(input.revision, 0, 100_000)
      || !LANGUAGE.test(input.language) || !Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 0 || !text) {
      return { accepted: false, reason: "invalid-caption", transientText: "" };
    }
    if (this.authorizedSources.get(input.sourceId) !== input.sourceEpoch) {
      return { accepted: false, reason: "source-not-authorized", transientText: "" };
    }
    if (!this.consent.broadcastTextTrack && !this.consent.broadcastBurnIn) {
      return { accepted: false, reason: "not-shared", transientText: "" };
    }
    if (Math.abs(nowMs - input.capturedAtMs) > this.settings.syncBudgetMs || input.capturedAtMs < this.programStartedAtMs) {
      return { accepted: false, reason: "stale-caption", transientText: "" };
    }
    const revisionKey = `${input.sourceId}:${input.sourceEpoch}:${input.utteranceId}`;
    if ((this.revisions.get(revisionKey) ?? -1) >= input.revision) {
      return { accepted: false, reason: "duplicate-revision", transientText: "" };
    }
    this.revisions.set(revisionKey, input.revision);
    const displayText = this.settings.speakerMode === "custom" ? `${this.settings.speakerLabel}: ${text}` : text;
    if (!input.final) {
      if (this.consent.broadcastBurnIn) this.output.setBurnIn(displayText, this.settings.style, this.settings.positionPercent);
      return { accepted: true, reason: "accepted-partial", transientText: displayText };
    }
    const startMs = input.capturedAtMs - this.programStartedAtMs + this.settings.delayMs;
    const cue: BroadcastCaptionCue = Object.freeze({
      cueId: `cc-${this.discontinuitySequence}-${input.utteranceId}`,
      sourceId: input.sourceId,
      sourceEpoch: input.sourceEpoch,
      discontinuitySequence: this.discontinuitySequence,
      startMs,
      endMs: startMs + Math.min(6_000, Math.max(1_500, text.length * 70)),
      language: input.language,
      lines: wrapText(displayText, this.settings.maximumLineLength),
      positionPercent: this.settings.positionPercent,
      style: this.settings.style,
    });
    this.cues = [...this.cues.filter((entry) => entry.endMs >= startMs - LIVE_WINDOW_MS), cue].slice(-MAX_CUES);
    if (this.consent.broadcastBurnIn) this.output.setBurnIn(cue.lines.join("\n"), cue.style, cue.positionPercent);
    const segment = this.segment();
    if (this.consent.broadcastTextTrack) this.output.publishTextTrack(segment);
    return { accepted: true, reason: "accepted-final", transientText: "", cue, segment };
  }

  discontinuity(reason: BroadcastCaptionDiscontinuityReason, programStartedAtMs: number): boolean {
    if (!Number.isSafeInteger(programStartedAtMs) || programStartedAtMs < 0) return false;
    void reason;
    this.programStartedAtMs = programStartedAtMs;
    this.discontinuitySequence += 1;
    this.cues = [];
    this.revisions.clear();
    this.clearOutputs();
    return true;
  }

  revokeSource(sourceId: string): boolean {
    if (!this.authorizedSources.delete(sourceId)) return false;
    this.cues = this.cues.filter((cue) => cue.sourceId !== sourceId);
    for (const key of [...this.revisions.keys()]) if (key.startsWith(`${sourceId}:`)) this.revisions.delete(key);
    this.discontinuitySequence += 1;
    this.clearOutputs();
    return true;
  }

  snapshotForLateJoin(nowMs: number): BroadcastCaptionSegment | null {
    if (!Number.isSafeInteger(nowMs) || nowMs < this.programStartedAtMs || !this.consent.broadcastTextTrack) return null;
    const elapsed = nowMs - this.programStartedAtMs;
    this.cues = this.cues.filter((cue) => cue.endMs >= elapsed - LIVE_WINDOW_MS);
    return this.cues.length ? this.segment() : null;
  }

  close(): void {
    this.authorizedSources.clear();
    this.revisions.clear();
    this.cues = [];
    this.consent = DEFAULT_BROADCAST_CAPTION_CONSENT;
    this.clearOutputs();
  }

  private segment(): BroadcastCaptionSegment {
    let selected = [...this.cues];
    let body = `WEBVTT\n\n${selected.map(cueText).join("\n\n")}\n`;
    while (new TextEncoder().encode(body).byteLength > MAX_SEGMENT_BYTES && selected.length > 1) {
      selected = selected.slice(1);
      body = `WEBVTT\n\n${selected.map(cueText).join("\n\n")}\n`;
    }
    return Object.freeze({
      format: "webvtt",
      mediaSequence: this.mediaSequence++,
      discontinuitySequence: this.discontinuitySequence,
      startsAtMs: selected[0]?.startMs ?? 0,
      endsAtMs: selected.at(-1)?.endMs ?? 0,
      cueCount: selected.length,
      body,
    });
  }

  private clearOutputs(): void {
    this.output.clearBurnIn();
    this.output.revokeTextTrack(this.discontinuitySequence);
  }
}
