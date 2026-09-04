import { describe, expect, it } from "vitest";

import { normalizeWhipAuthorization, normalizeWhipRuntimeConfiguration } from "./whip-contracts";

function configuration() {
  return {
    configurationVersion: 1 as const,
    compatibilityProfile: "rfc9725" as const,
    endpointUrl: "https://media.example.test/live/whip",
    allowedRedirectOrigins: ["https://edge.example.test"],
    iceServers: [{ urls: ["stun:stun.example.test", "turns:turn.example.test"], username: "u", credential: "p" }],
    codecPreferences: { audio: ["audio/opus"], video: ["video/vp8", "video/h264"] },
    simulcast: { enabled: false, sendEncodings: [] },
    trickleIce: true,
    requestTimeoutMs: 5_000,
    iceGatheringTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
    maximumResponseBytes: 128 * 1024,
    maximumSdpBytes: 64 * 1024,
    maximumIceFragmentBytes: 8 * 1024,
    maximumCandidates: 32,
    retryBudget: 1,
  };
}

describe("WHIP browser contracts", () => {
  it("normalizes a closed HTTPS runtime policy without secrets", () => {
    const normalized = normalizeWhipRuntimeConfiguration(configuration());
    expect(normalized.endpointUrl).toBe("https://media.example.test/live/whip");
    expect(normalized.allowedRedirectOrigins).toEqual([
      "https://media.example.test", "https://edge.example.test",
    ]);
    expect(Object.isFrozen(normalized.iceServers)).toBe(true);
  });

  it("rejects URL credentials, query tokens, unsafe ICE fields and invalid simulcast", () => {
    expect(() => normalizeWhipRuntimeConfiguration({
      ...configuration(), endpointUrl: "https://token@media.example.test/live/whip",
    })).toThrow("invalid_whip_runtime_configuration");
    expect(() => normalizeWhipRuntimeConfiguration({
      ...configuration(), endpointUrl: "https://media.example.test/live/whip?token=secret",
    })).toThrow("invalid_whip_runtime_configuration");
    expect(() => normalizeWhipRuntimeConfiguration({
      ...configuration(), iceServers: [{ urls: "https://not-ice.example.test" }],
    })).toThrow("invalid_whip_runtime_configuration");
    expect(() => normalizeWhipRuntimeConfiguration({
      ...configuration(), simulcast: { enabled: true, sendEncodings: [] },
    })).toThrow("invalid_whip_runtime_configuration");
  });

  it("accepts only fresh, bounded bearer material", () => {
    const now = 1_800_000_000_000;
    expect(normalizeWhipAuthorization({
      authorizationVersion: 1,
      accessToken: "header.payload.signature",
      expiresAt: now + 60_000,
    }, now).expiresAt).toBe(now + 60_000);
    expect(() => normalizeWhipAuthorization({
      authorizationVersion: 1,
      accessToken: "header.payload.signature",
      expiresAt: now - 1,
    }, now)).toThrow("invalid_whip_authorization");
    expect(() => normalizeWhipAuthorization({
      authorizationVersion: 1,
      accessToken: "secret\nheader:value",
      expiresAt: now + 60_000,
    }, now)).toThrow("invalid_whip_authorization");
  });
});
