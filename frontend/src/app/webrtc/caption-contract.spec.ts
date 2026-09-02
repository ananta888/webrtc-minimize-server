import { describe, expect, it } from "vitest";

import {
  CaptionRateLimiter,
  CaptionRevisionTracker,
  MAX_CAPTION_MESSAGES_PER_WINDOW,
  encodeCaptionMessage,
  parseCaptionMessage,
} from "./caption-contract";

const valid = Object.freeze({
  utteranceId: "0123456789abcdef",
  revision: 0,
  language: "de-DE",
  text: "Guten Morgen",
  final: false,
  source: "microphone" as const,
});

describe("caption peer contract", () => {
  it("round-trips a bounded versioned caption", () => {
    const encoded = encodeCaptionMessage(valid);
    expect(parseCaptionMessage(encoded)).toEqual({ version: 2, type: "caption", ...valid });
  });

  it("accepts exact v1 messages as microphone captions and rejects unknown v2 sources", () => {
    const { source: _source, ...legacy } = valid;
    expect(parseCaptionMessage(JSON.stringify({ version: 1, type: "caption", ...legacy }))).toEqual({
      version: 1,
      type: "caption",
      ...legacy,
      source: "microphone",
    });
    expect(parseCaptionMessage(JSON.stringify({ version: 2, type: "caption", ...valid, source: "system-audio" }))).toBeNull();
    expect(parseCaptionMessage(JSON.stringify({ version: 1, type: "caption", ...valid }))).toBeNull();
  });

  it("rejects unknown fields, malformed identities, languages and oversized text", () => {
    expect(parseCaptionMessage(JSON.stringify({ version: 1, type: "caption", ...valid, peerName: "fake" }))).toBeNull();
    expect(encodeCaptionMessage({ ...valid, utteranceId: "not-an-id" })).toBeNull();
    expect(encodeCaptionMessage({ ...valid, language: "../../secret" })).toBeNull();
    expect(encodeCaptionMessage({ ...valid, text: "x".repeat(501) })).toBeNull();
    expect(parseCaptionMessage(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("accepts only a monotonic revision stream per authenticated peer", () => {
    const tracker = new CaptionRevisionTracker();
    const first = parseCaptionMessage(encodeCaptionMessage(valid))!;
    const next = parseCaptionMessage(encodeCaptionMessage({ ...valid, revision: 1, text: "Guten Morgen zusammen" }))!;
    const final = parseCaptionMessage(encodeCaptionMessage({ ...valid, revision: 2, text: "Guten Morgen zusammen", final: true }))!;
    expect(tracker.accept("peer-a", first)).toBe(true);
    expect(tracker.accept("peer-a", first)).toBe(false);
    expect(tracker.accept("peer-a", next)).toBe(true);
    expect(tracker.accept("peer-a", final)).toBe(true);
    expect(tracker.accept("peer-a", { ...final, revision: 3 })).toBe(false);
    expect(tracker.accept("peer-a", { ...first, utteranceId: "fedcba9876543210" })).toBe(true);
    expect(tracker.accept("peer-b", { ...first, revision: 1 })).toBe(false);
  });

  it("drops caption bursts without affecting a later rate window", () => {
    const limiter = new CaptionRateLimiter();
    for (let index = 0; index < MAX_CAPTION_MESSAGES_PER_WINDOW; index += 1) {
      expect(limiter.accept("peer-a", 1_000)).toBe(true);
    }
    expect(limiter.accept("peer-a", 1_001)).toBe(false);
    expect(limiter.accept("peer-b", 1_001)).toBe(true);
    expect(limiter.accept("peer-a", 6_000)).toBe(true);
  });
});
