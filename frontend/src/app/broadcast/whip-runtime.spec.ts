import { describe, expect, it } from "vitest";

import { RuntimeConfig, validWhipRuntime } from "../core/runtime-config.service";
import { whipRuntimeConfiguration } from "./whip-runtime";

function runtime(enabled: boolean): RuntimeConfig {
  return {
    iceServers: [{ urls: "turns:turn.example.test", username: "short", credential: "lived" }],
    maxRoomParticipants: 20,
    pairParticipants: 2,
    turnConfigured: true,
    edgeRelayConfigured: false,
    mediaE2ee: { mode: "required", cipherSuite: "AES_128_GCM_SHA256_128", frameEnvelope: "codec-prefix-v1" },
    mediaAgents: {
      configured: false, selfService: false, targets: [], unsignedArtifacts: false,
      leaseMs: 30_000, maxStandbys: 2, minimumParticipants: 3, shardMinParticipants: 6,
    },
    broadcast: {
      whip: {
        configurationVersion: 1,
        compatibilityProfile: "rfc9725",
        enabled,
        endpointUrl: enabled ? "https://media.example.test/live/whip" : "",
        allowedRedirectOrigins: [],
        trickleIce: true,
        simulcast: { enabled: false, sendEncodings: [] },
        codecPreferences: { audio: ["audio/opus"], video: ["video/vp8"] },
        requestTimeoutMs: 8_000,
        iceGatheringTimeoutMs: 10_000,
        connectionTimeoutMs: 20_000,
        maximumResponseBytes: 128 * 1024,
        maximumSdpBytes: 64 * 1024,
        maximumIceFragmentBytes: 16 * 1024,
        maximumCandidates: 64,
        retryBudget: 1,
      },
    },
    optimization: {
      activeSpeakerLimit: 5, peerRelayEnabled: true, peerRelayMinParticipants: 3,
      peerRelayMaxChildren: 3, peerRelayMaxHops: 3, routeLeaseMs: 60_000, dataOverlayEnabled: true,
    },
    pairWorkspaceEnabled: true,
    auth: { mode: "required", issuer: "https://identity.example", clientId: "browser", audience: "rooms" },
  };
}

describe("trusted WHIP runtime mapping", () => {
  it("derives ICE, codecs and protocol limits only from public runtime configuration", () => {
    const result = whipRuntimeConfiguration(runtime(true));
    expect(result.endpointUrl).toBe("https://media.example.test/live/whip");
    expect(result.iceServers).toEqual([
      { urls: "turns:turn.example.test", username: "short", credential: "lived" },
    ]);
    expect(result.codecPreferences.video).toEqual(["video/vp8"]);
    expect(Object.hasOwn(result, "accessToken")).toBe(false);
  });

  it("keeps the adapter unavailable when the operator endpoint is disabled", () => {
    expect(() => whipRuntimeConfiguration(runtime(false))).toThrow("whip-not-configured");
  });

  it("rejects malformed nested runtime fields without throwing implementation errors", () => {
    const malformedSimulcast = structuredClone(runtime(true)) as unknown as {
      broadcast: { whip: { simulcast: { enabled: boolean; sendEncodings?: unknown[] } } };
    };
    delete malformedSimulcast.broadcast.whip.simulcast.sendEncodings;
    expect(validWhipRuntime(malformedSimulcast as unknown as RuntimeConfig)).toBe(false);

    const unsafeRedirect = structuredClone(runtime(true)) as unknown as {
      broadcast: { whip: { allowedRedirectOrigins: string[] } };
    };
    unsafeRedirect.broadcast.whip.allowedRedirectOrigins = ["https://edge.example.test/path"];
    expect(validWhipRuntime(unsafeRedirect as unknown as RuntimeConfig)).toBe(false);

    const invalidCodec = structuredClone(runtime(true)) as unknown as {
      broadcast: { whip: { codecPreferences: { video: string[] } } };
    };
    invalidCodec.broadcast.whip.codecPreferences.video = ["audio/opus"];
    expect(validWhipRuntime(invalidCodec as unknown as RuntimeConfig)).toBe(false);
  });

  it("accepts only bounded strict-profile simulcast and maps it without inventing layers", () => {
    const configured = structuredClone(runtime(true)) as unknown as {
      broadcast: { whip: {
        compatibilityProfile: "rfc9725" | "mediamtx-1.20";
        simulcast: { enabled: boolean; sendEncodings: RTCRtpEncodingParameters[] };
      } };
    };
    configured.broadcast.whip.simulcast = {
      enabled: true,
      sendEncodings: [
        { rid: "q", active: true, maxBitrate: 120_000, maxFramerate: 6, scaleResolutionDownBy: 4 },
        { rid: "f", active: true, maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
      ],
    };
    expect(validWhipRuntime(configured as unknown as RuntimeConfig)).toBe(true);
    expect(whipRuntimeConfiguration(configured as unknown as RuntimeConfig).simulcast.sendEncodings)
      .toHaveLength(2);
    configured.broadcast.whip.compatibilityProfile = "mediamtx-1.20";
    expect(validWhipRuntime(configured as unknown as RuntimeConfig)).toBe(false);
  });
});
