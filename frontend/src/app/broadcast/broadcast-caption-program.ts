import { BroadcastCaptionConsent, BroadcastCaptionSettings, BroadcastCaptionOutputPort, BroadcastCaptionInput, BroadcastCaptionResult, BroadcastCaptionCue, BroadcastCaptionSegment, BroadcastCaptionDiscontinuityReason, DEFAULT_BROADCAST_CAPTION_CONSENT, DEFAULT_BROADCAST_CAPTION_SETTINGS, normalizeBroadcastCaptionConsent, normalizeBroadcastCaptionSettings } from "./broadcast-caption-packager";

const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const UTTERANCE_ID = /^[a-f0-9]{16}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const MAX_CAPTION_TEXT = 500;
const MAX_CUES = 32;
const MAX_SEGMENT_BYTES = 64 * 1024;
const LIVE_WINDOW_MS = 30_000;
const MAX_SOURCES = 80;
const MAX_SOURCE_IDENTITIES = 1024;
const MAX_REVISIONS = 1024;
const MAX_SYNC_MS = 8000;

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
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
  private readonly revisions = new Map<string, { revision: number; expiresAt: number }>();
  private readonly authorizedSources = new Map<string, number>();
  private readonly sourceEpochs = new Map<string, number>();
  private cues: BroadcastCaptionCue[] = [];
  private programStartedAtMs = -1;
  private lastObservedAtMs = -1;
  private consentNotBeforeMs = -1;
  private mediaSequence = 0;
  private discontinuitySequence = 0;
  private consent = DEFAULT_BROADCAST_CAPTION_CONSENT;
  private settings = DEFAULT_BROADCAST_CAPTION_SETTINGS;

  constructor(private readonly output: BroadcastCaptionOutputPort) {}

  begin(programStartedAtMs: number, consent: BroadcastCaptionConsent, settings: BroadcastCaptionSettings): boolean {
    const normalizedConsent = normalizeBroadcastCaptionConsent(consent);
    const normalizedSettings = normalizeBroadcastCaptionSettings(settings);
    if (!Number.isSafeInteger(programStartedAtMs) || programStartedAtMs < 0 || !normalizedConsent || !normalizedSettings) return false;
    this.close();
    this.programStartedAtMs = programStartedAtMs;
    this.consentNotBeforeMs = programStartedAtMs - 1;
    this.consent = normalizedConsent;
    this.settings = normalizedSettings;
    return true;
  }

  reconfigure(consent: BroadcastCaptionConsent, settings: BroadcastCaptionSettings, nowMs = Date.now()): boolean {
    const normalizedConsent = normalizeBroadcastCaptionConsent(consent);
    const normalizedSettings = normalizeBroadcastCaptionSettings(settings);
    if (!normalizedConsent || !normalizedSettings || this.programStartedAtMs < 0) return false;
    if (!Number.isSafeInteger(nowMs) || nowMs < this.programStartedAtMs || nowMs < this.lastObservedAtMs) {
      this.close(); return false; // Uncertain time never preserves a revoked destination.
    }
    this.lastObservedAtMs = nowMs;
    if (normalizedConsent.broadcastTextTrack !== this.consent.broadcastTextTrack
      || normalizedConsent.broadcastBurnIn !== this.consent.broadcastBurnIn) {
      this.discontinuitySequence += 1;
      this.consentNotBeforeMs = nowMs;
      this.cues = [];
      // Keep replay high-water marks until their bounded capture window expires.
      this.clearOutputs();
    }
    this.consent = normalizedConsent;
    this.settings = normalizedSettings;
    return true;
  }

  authorizeSource(sourceId: string, sourceEpoch: number): boolean {
    if (this.programStartedAtMs < 0 || !SOURCE_ID.test(sourceId) || !Number.isSafeInteger(sourceEpoch) || sourceEpoch < 1) return false;
    const previous = this.sourceEpochs.get(sourceId), active = this.authorizedSources.has(sourceId);
    if (previous !== undefined && (sourceEpoch < previous || sourceEpoch === previous && !active)) return false;
    if (!active && this.authorizedSources.size >= MAX_SOURCES
      || previous === undefined && this.sourceEpochs.size >= MAX_SOURCE_IDENTITIES) return false;
    if (active && previous !== undefined && sourceEpoch > previous) this.revokeSource(sourceId);
    this.sourceEpochs.set(sourceId, sourceEpoch);
    this.authorizedSources.set(sourceId, sourceEpoch);
    return true;
  }

  ingest(input: BroadcastCaptionInput, nowMs: number): BroadcastCaptionResult {
    const text = normalizeCaptionText(input?.text);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !input || !SOURCE_ID.test(input.sourceId)
      || !UTTERANCE_ID.test(input.utteranceId) || !integerInRange(input.revision, 0, 100_000)
      || !Number.isSafeInteger(input.sourceEpoch) || input.sourceEpoch < 1 || typeof input.final !== "boolean"
      || !LANGUAGE.test(input.language) || !Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 0 || !text) {
      return { accepted: false, reason: "invalid-caption", transientText: "" };
    }
    if (this.programStartedAtMs < 0 || this.authorizedSources.get(input.sourceId) !== input.sourceEpoch) {
      return { accepted: false, reason: "source-not-authorized", transientText: "" };
    }
    if (!this.consent.broadcastTextTrack && !this.consent.broadcastBurnIn) {
      return { accepted: false, reason: "not-shared", transientText: "" };
    }
    if (nowMs < this.lastObservedAtMs || Math.abs(nowMs - input.capturedAtMs) > this.settings.syncBudgetMs
      || input.capturedAtMs < this.programStartedAtMs || input.capturedAtMs <= this.consentNotBeforeMs) {
      return { accepted: false, reason: "stale-caption", transientText: "" };
    }
    this.lastObservedAtMs = nowMs;
    for (const [key, record] of this.revisions) if (record.expiresAt < nowMs) this.revisions.delete(key);
    const revisionKey = `${input.sourceId}:${input.sourceEpoch}:${input.utteranceId}`;
    const previous = this.revisions.get(revisionKey);
    if ((previous?.revision ?? -1) >= input.revision) {
      return { accepted: false, reason: "duplicate-revision", transientText: "" };
    }
    if (!previous && this.revisions.size >= MAX_REVISIONS) return { accepted: false, reason: "capacity-exceeded", transientText: "" };
    this.revisions.set(revisionKey, { revision: input.revision, expiresAt: Math.max(previous?.expiresAt ?? 0, input.capturedAtMs + MAX_SYNC_MS) });
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
    if (this.programStartedAtMs < 0 || !Number.isSafeInteger(programStartedAtMs) || programStartedAtMs < this.programStartedAtMs
      || !["source-change", "pause", "resume", "handoff", "player-resync", "revoke"].includes(reason)) return false;
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
    if (this.programStartedAtMs < 0 || !Number.isSafeInteger(nowMs) || nowMs < this.programStartedAtMs
      || nowMs < this.lastObservedAtMs || !this.consent.broadcastTextTrack) return null;
    this.lastObservedAtMs = nowMs;
    const elapsed = nowMs - this.programStartedAtMs;
    this.cues = this.cues.filter((cue) => cue.endMs >= elapsed - LIVE_WINDOW_MS);
    return this.cues.length ? this.segment() : null;
  }

  close(): void {
    if (this.programStartedAtMs >= 0) this.discontinuitySequence += 1;
    this.programStartedAtMs = -1;
    this.lastObservedAtMs = -1;
    this.consentNotBeforeMs = -1;
    this.authorizedSources.clear();
    this.sourceEpochs.clear();
    this.revisions.clear();
    this.cues = [];
    this.consent = DEFAULT_BROADCAST_CAPTION_CONSENT;
    this.settings = DEFAULT_BROADCAST_CAPTION_SETTINGS;
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
      language: selected.at(-1)?.language ?? this.settings.language,
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
