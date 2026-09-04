import { describe, expect, it, vi } from "vitest";

import {
  BrowserBroadcastCaptionPackager,
  DEFAULT_BROADCAST_CAPTION_CONSENT,
  DEFAULT_BROADCAST_CAPTION_SETTINGS,
  normalizeBroadcastCaptionSettings,
} from "./broadcast-caption-packager";

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
