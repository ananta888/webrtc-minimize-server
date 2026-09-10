import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BROADCAST_CAPTION_CONSENT,
  DEFAULT_BROADCAST_CAPTION_SETTINGS,
  normalizeBroadcastCaptionSettings,
} from "./broadcast-caption-packager";
import { BrowserBroadcastCaptionPackager } from "./broadcast-caption-program";

const SOURCE_ID = "src_aaaaaaaaaaaaaaaa";
const STARTED_AT = 1_000_000;

function fixture(consent = {
  ...DEFAULT_BROADCAST_CAPTION_CONSENT,
  broadcastTextTrack: true,
  broadcastBurnIn: true,
}) {
  const output = {
    setBurnIn: vi.fn(),
    clearBurnIn: vi.fn(),
    publishTextTrack: vi.fn(),
    revokeTextTrack: vi.fn(),
  };
  const packager = new BrowserBroadcastCaptionPackager(output);
  expect(packager.begin(STARTED_AT, consent, DEFAULT_BROADCAST_CAPTION_SETTINGS)).toBe(true);
  expect(packager.authorizeSource(SOURCE_ID, 4)).toBe(true);
  return { packager, output };
}

function caption(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: SOURCE_ID,
    sourceEpoch: 4,
    utteranceId: "0123456789abcdef",
    revision: 1,
    language: "de-DE",
    text: "Das ist ein finalisierter Untertitel.",
    final: true,
    capturedAtMs: STARTED_AT + 2_000,
    ...overrides,
  };
}

describe("BrowserBroadcastCaptionPackager", () => {
  it("begins a fresh authorization scope without retaining prior cues or sources", () => {
    const { packager } = fixture();
    expect(packager.ingest(caption(), STARTED_AT + 2100).accepted).toBe(true);
    expect(packager.begin(STARTED_AT + 3000, { ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastTextTrack: true }, DEFAULT_BROADCAST_CAPTION_SETTINGS)).toBe(true);
    expect(packager.snapshotForLateJoin(STARTED_AT + 3100)).toBeNull();
    expect(packager.ingest(caption({ capturedAtMs: STARTED_AT + 3100 }), STARTED_AT + 3100).reason).toBe("source-not-authorized");
  });

  it("cannot reopen a closed program by changing settings or authorizing a source", () => {
    const { packager } = fixture(); packager.close();
    expect(packager.authorizeSource(SOURCE_ID, 5)).toBe(false);
    expect(packager.reconfigure({ ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastTextTrack: true }, DEFAULT_BROADCAST_CAPTION_SETTINGS)).toBe(false);
    expect(packager.discontinuity("resume", STARTED_AT + 3000)).toBe(false);
  });

  it("bounds fresh utterance revisions without evicting replay protection", () => {
    const { packager } = fixture({ ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastTextTrack: true });
    for (let id = 0; id < 1024; id++) expect(packager.ingest(caption({ utteranceId: id.toString(16).padStart(16, "0"), final: false }), STARTED_AT + 2100).accepted).toBe(true);
    expect(packager.ingest(caption({ final: false }), STARTED_AT + 2100).reason).toBe("capacity-exceeded");
    expect(packager.ingest(caption({ utteranceId: "0000000000000000", final: false }), STARTED_AT + 2100).reason).toBe("duplicate-revision");
    expect(packager.ingest(caption({ utteranceId: "0000000000000000", final: false, revision: 2 }), STARTED_AT + 2100).accepted).toBe(true);
    expect(packager.reconfigure({ ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastTextTrack: true },
      { ...DEFAULT_BROADCAST_CAPTION_SETTINGS, syncBudgetMs: 8000 })).toBe(true);
    expect(packager.ingest(caption({ utteranceId: "0000000000000000", final: false, revision: 2 }), STARTED_AT + 10000).reason).toBe("duplicate-revision");
    expect(packager.ingest(caption({ capturedAtMs: STARTED_AT + 10001 }), STARTED_AT + 10001).accepted).toBe(true);
    expect(packager.ingest(caption({ utteranceId: "0000000000000000", revision: 3 }), STARTED_AT + 10001).reason).toBe("stale-caption");
    expect(packager.ingest(caption({ capturedAtMs: STARTED_AT + 2100 }), STARTED_AT + 2100).reason).toBe("stale-caption");
  });

  it("keeps revision state bounded across two simulated hours without ending a healthy caption stream", () => {
    const { packager } = fixture({ ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastTextTrack: true });
    for (let seconds = 0; seconds < 7200; seconds++) {
      const now = STARTED_AT + 2000 + seconds * 1000;
      expect(packager.ingest(caption({ utteranceId: seconds.toString(16).padStart(16, "0"), capturedAtMs: now, final: false }), now).accepted).toBe(true);
      expect(Reflect.get(packager, "revisions").size).toBeLessThanOrEqual(9);
    }
    packager.close(); expect(Reflect.get(packager, "revisions").size).toBe(0);
  });

  it("bounds sources and purges an explicitly replaced epoch while rejecting downgrade", () => {
    const { packager } = fixture();
    expect(packager.ingest(caption(), STARTED_AT + 2100).accepted).toBe(true);
    for (let id = 0; id < 79; id++) expect(packager.authorizeSource(`src_${id.toString(16).padStart(16, "0")}`, 1)).toBe(true);
    expect(packager.authorizeSource("src_bbbbbbbbbbbbbbbb", 1)).toBe(false);
    expect(packager.authorizeSource(SOURCE_ID, 3)).toBe(false);
    expect(packager.authorizeSource(SOURCE_ID, 4)).toBe(true);
    expect(packager.authorizeSource(SOURCE_ID, 5)).toBe(true);
    expect(packager.snapshotForLateJoin(STARTED_AT + 2100)).toBeNull();
    expect(packager.ingest(caption(), STARTED_AT + 2200).reason).toBe("source-not-authorized");
    expect(packager.ingest(caption({ sourceEpoch: 5 }), STARTED_AT + 2200).accepted).toBe(true);
    expect(packager.revokeSource(SOURCE_ID)).toBe(true);
    expect(packager.authorizeSource("src_bbbbbbbbbbbbbbbb", 1)).toBe(true);
  });

  it("does not accept inactive configuration, malformed final flags or unknown discontinuities", () => {
    const { packager } = fixture();
    expect(packager.ingest(caption({ final: "false" }), STARTED_AT + 2100).reason).toBe("invalid-caption");
    expect(packager.discontinuity("unknown" as never, STARTED_AT + 3000)).toBe(false);
    expect(packager.discontinuity("resume", STARTED_AT - 1)).toBe(false);
    packager.close(); expect(packager.snapshotForLateJoin(STARTED_AT + 3100)).toBeNull();
    expect(packager.ingest(caption(), STARTED_AT + 2100).reason).toBe("source-not-authorized");
    expect(packager.begin(STARTED_AT + 3000, DEFAULT_BROADCAST_CAPTION_CONSENT, DEFAULT_BROADCAST_CAPTION_SETTINGS)).toBe(true);
    expect(packager.authorizeSource(SOURCE_ID, 6)).toBe(true);
    expect(packager.ingest(caption({ sourceEpoch: 6, capturedAtMs: STARTED_AT + 3100 }), STARTED_AT + 3100).reason).toBe("not-shared");
  });
  it("defaults every caption destination to off and validates bounded presentation settings", () => {
    expect(DEFAULT_BROADCAST_CAPTION_CONSENT).toEqual({
      policyVersion: 1,
      localOverlay: false,
      shareWithRoom: false,
      broadcastTextTrack: false,
      broadcastBurnIn: false,
    });
    expect(normalizeBroadcastCaptionSettings({ ...DEFAULT_BROADCAST_CAPTION_SETTINGS, maximumLineLength: 19 })).toBeNull();
    expect(normalizeBroadcastCaptionSettings({ ...DEFAULT_BROADCAST_CAPTION_SETTINGS, speakerMode: "custom", speakerLabel: "" })).toBeNull();
  });

  it("keeps partial text transient and emits only finalized bounded WebVTT", () => {
    const { packager, output } = fixture();
    const partial = packager.ingest(caption({ final: false }), STARTED_AT + 2_100);
    expect(partial.reason).toBe("accepted-partial");
    expect(partial.segment).toBeUndefined();
    expect(output.publishTextTrack).not.toHaveBeenCalled();
    expect(output.setBurnIn).toHaveBeenCalledOnce();

    const final = packager.ingest(caption({ revision: 2 }), STARTED_AT + 2_200);
    expect(final.reason).toBe("accepted-final");
    expect(final.segment?.body).toContain("WEBVTT");
    expect(final.segment?.body).toContain("Das ist ein finalisierter");
    expect(final.segment?.cueCount).toBe(1);
    expect(new TextEncoder().encode(final.segment?.body || "").byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(output.publishTextTrack).toHaveBeenCalledOnce();
  });

  it("does not emit anything without explicit broadcast consent", () => {
    const { packager, output } = fixture(DEFAULT_BROADCAST_CAPTION_CONSENT);
    expect(packager.ingest(caption(), STARTED_AT + 2_100).reason).toBe("not-shared");
    expect(output.publishTextTrack).not.toHaveBeenCalled();
    expect(output.setBurnIn).not.toHaveBeenCalled();
  });

  it("rejects stale, duplicate and wrong-epoch captions", () => {
    const { packager } = fixture();
    expect(packager.ingest(caption({ capturedAtMs: STARTED_AT + 100 }), STARTED_AT + 10_000).reason).toBe("stale-caption");
    expect(packager.ingest(caption(), STARTED_AT + 2_100).accepted).toBe(true);
    expect(packager.ingest(caption(), STARTED_AT + 2_100).reason).toBe("duplicate-revision");
    expect(packager.ingest(caption({ sourceEpoch: 3, revision: 2 }), STARTED_AT + 2_100).reason).toBe("source-not-authorized");
    expect(packager.ingest(caption({ utteranceId: "fedcba9876543210", text: "safe\u202Etxt" }), STARTED_AT + 2_100).reason).toBe("invalid-caption");
  });

  it("purges cues and fences old source epochs on revoke", () => {
    const { packager, output } = fixture();
    expect(packager.ingest(caption(), STARTED_AT + 2_100).accepted).toBe(true);
    expect(packager.revokeSource(SOURCE_ID)).toBe(true);
    expect(packager.snapshotForLateJoin(STARTED_AT + 2_500)).toBeNull();
    expect(packager.ingest(caption({ revision: 2 }), STARTED_AT + 2_600).reason).toBe("source-not-authorized");
    expect(output.clearBurnIn).toHaveBeenCalled();
    expect(output.revokeTextTrack).toHaveBeenLastCalledWith(1);
  });

  it("starts an empty caption generation after handoff and never replays older cues", () => {
    const { packager, output } = fixture();
    expect(packager.ingest(caption(), STARTED_AT + 2_100).accepted).toBe(true);
    expect(packager.discontinuity("handoff", STARTED_AT + 3_000)).toBe(true);
    expect(packager.snapshotForLateJoin(STARTED_AT + 3_100)).toBeNull();
    expect(output.revokeTextTrack).toHaveBeenLastCalledWith(1);
  });

  it("applies live consent changes without replaying text from a disabled destination", () => {
    const { packager, output } = fixture();
    expect(packager.ingest(caption(), STARTED_AT + 2_100).accepted).toBe(true);
    expect(packager.reconfigure({
      ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastBurnIn: false, broadcastTextTrack: false,
    }, DEFAULT_BROADCAST_CAPTION_SETTINGS)).toBe(true);
    expect(output.clearBurnIn).toHaveBeenCalled();
    expect(output.revokeTextTrack).toHaveBeenLastCalledWith(1);
    expect(packager.snapshotForLateJoin(STARTED_AT + 2_200)).toBeNull();
    expect(packager.reconfigure({
      ...DEFAULT_BROADCAST_CAPTION_CONSENT, broadcastTextTrack: true,
    }, DEFAULT_BROADCAST_CAPTION_SETTINGS)).toBe(true);
    expect(packager.snapshotForLateJoin(STARTED_AT + 2_300)).toBeNull();
  });
});
