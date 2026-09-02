export const MAX_CAPTION_TEXT_LENGTH = 500;
export const MAX_CAPTION_MESSAGE_BYTES = 2_048;
export const CAPTION_BUFFER_LIMIT = 64_000;
export const CAPTION_RATE_WINDOW_MS = 5_000;
export const MAX_CAPTION_MESSAGES_PER_WINDOW = 24;

const UTTERANCE_ID = /^[a-f0-9]{16}$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const CAPTION_FIELDS = new Set(["version", "type", "utteranceId", "revision", "language", "text", "final"]);

export interface CaptionWireMessage {
  readonly version: 1;
  readonly type: "caption";
  readonly utteranceId: string;
  readonly revision: number;
  readonly language: string;
  readonly text: string;
  readonly final: boolean;
}

export function parseCaptionMessage(raw: unknown): CaptionWireMessage | null {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_CAPTION_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== CAPTION_FIELDS.size
      || Object.keys(value).some((key) => !CAPTION_FIELDS.has(key))
      || value["version"] !== 1 || value["type"] !== "caption"
      || typeof value["utteranceId"] !== "string" || !UTTERANCE_ID.test(value["utteranceId"])
      || !Number.isSafeInteger(value["revision"]) || Number(value["revision"]) < 0 || Number(value["revision"]) > 1_000_000
      || typeof value["language"] !== "string" || !LANGUAGE_TAG.test(value["language"])
      || typeof value["text"] !== "string" || !value["text"].trim() || value["text"].length > MAX_CAPTION_TEXT_LENGTH
      || typeof value["final"] !== "boolean") return null;
    return Object.freeze({
      version: 1,
      type: "caption",
      utteranceId: value["utteranceId"],
      revision: Number(value["revision"]),
      language: value["language"],
      text: value["text"].trim(),
      final: value["final"],
    });
  } catch {
    return null;
  }
}

export function encodeCaptionMessage(message: Omit<CaptionWireMessage, "version" | "type">): string | null {
  const encoded = JSON.stringify({ version: 1, type: "caption", ...message });
  return parseCaptionMessage(encoded) ? encoded : null;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

export class CaptionRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  accept(peerId: string, now = Date.now()): boolean {
    const current = this.windows.get(peerId);
    if (!current || now - current.startedAt >= CAPTION_RATE_WINDOW_MS || now < current.startedAt) {
      this.windows.set(peerId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= MAX_CAPTION_MESSAGES_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }

  remove(peerId: string): void {
    this.windows.delete(peerId);
  }

  clear(): void {
    this.windows.clear();
  }
}

interface RevisionState {
  readonly utteranceId: string;
  readonly revision: number;
  readonly final: boolean;
}

export class CaptionRevisionTracker {
  private readonly states = new Map<string, RevisionState>();

  accept(peerId: string, message: CaptionWireMessage): boolean {
    const previous = this.states.get(peerId);
    if (!previous || previous.utteranceId !== message.utteranceId) {
      if (message.revision !== 0) return false;
      this.states.set(peerId, {
        utteranceId: message.utteranceId,
        revision: message.revision,
        final: message.final,
      });
      return true;
    }
    if (previous.final || message.revision <= previous.revision) return false;
    this.states.set(peerId, {
      utteranceId: message.utteranceId,
      revision: message.revision,
      final: message.final,
    });
    return true;
  }

  remove(peerId: string): void {
    this.states.delete(peerId);
  }

  clear(): void {
    this.states.clear();
  }
}
