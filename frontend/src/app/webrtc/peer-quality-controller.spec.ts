import { describe, expect, it, vi } from "vitest";

import { QUALITY_SETTINGS } from "./media-optimization-policy";
import { ManagedPeer } from "./peer-connection-manager";
import { PeerQualityController } from "./peer-quality-controller";

function fakePeer(): ManagedPeer {
  return {
    appliedTiers: new Map(),
  } as unknown as ManagedPeer;
}

function fakeSender(setParameters = vi.fn().mockResolvedValue(undefined)) {
  return {
    track: { kind: "video" },
    getParameters: vi.fn(() => ({ encodings: [{}] } as unknown as RTCRtpSendParameters)),
    setParameters,
  } as unknown as RTCRtpSender;
}

describe("PeerQualityController sender policies", () => {
  it("samples total, audio, camera, screen and data counters without exposing candidate details", async () => {
    const reports = new Map<string, Record<string, unknown>>([
      ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", selected: true, bytesSent: 12_000, bytesReceived: 9_000, availableOutgoingBitrate: 2_000_000 }],
      ["audio-out", { id: "audio-out", type: "outbound-rtp", kind: "audio", trackIdentifier: "mic", bytesSent: 1_000 }],
      ["video-out", { id: "video-out", type: "outbound-rtp", kind: "video", trackIdentifier: "cam", bytesSent: 4_000 }],
      ["screen-out", { id: "screen-out", type: "outbound-rtp", kind: "video", trackIdentifier: "share", bytesSent: 6_000 }],
      ["audio-in", { id: "audio-in", type: "inbound-rtp", mediaType: "audio", trackIdentifier: "remote-mic", bytesReceived: 800 }],
      ["screen-in", { id: "screen-in", type: "inbound-rtp", mediaType: "video", trackIdentifier: "remote-share", bytesReceived: 7_000 }],
      ["data", { id: "data", type: "data-channel", bytesSent: 100, bytesReceived: 200 }],
    ]);
    const peer = {
      pc: { getStats: vi.fn(async () => reports as unknown as RTCStatsReport) },
      linkClass: "unknown",
      linkCandidate: "unknown",
      linkCandidateSince: 0,
    } as unknown as ManagedPeer;

    const sample = await new PeerQualityController().sample(peer, 2_000, new Map([
      ["mic", "microphone"],
      ["cam", "camera"],
      ["share", "screen"],
      ["remote-mic", "microphone"],
      ["remote-share", "screen"],
    ]));

    expect(sample.trafficCounters).toEqual({
      sampledAt: 2_000,
      outgoingBytes: 12_000,
      incomingBytes: 9_000,
      audioOutgoingBytes: 1_000,
      audioIncomingBytes: 800,
      videoOutgoingBytes: 4_000,
      videoIncomingBytes: 0,
      screenOutgoingBytes: 6_000,
      screenIncomingBytes: 7_000,
      dataOutgoingBytes: 100,
      dataIncomingBytes: 200,
    });
  });

  it("applies an audio minimum, sender ceiling and both relative priorities", async () => {
    const peer = fakePeer();
    const sender = fakeSender();
    const result = await new PeerQualityController().applyAudio(
      peer,
      "microphone:own",
      sender,
      { priority: "high", maxBitrate: 24_000 },
      false,
    );
    expect(result).toBe("available");
    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [{ active: true, maxBitrate: 24_000, priority: "high", networkPriority: "high" }],
    });
    expect(peer.appliedTiers.get("microphone:own")).toBe("audio:24000:high");

    await new PeerQualityController().applyAudio(
      peer,
      "microphone:minimum",
      sender,
      { priority: "low", maxBitrate: 1 },
      false,
    );
    expect((sender.setParameters as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].encodings[0].maxBitrate)
      .toBe(20_000);
  });

  it("keeps screen resolution degradation distinct from its adaptive tier name", async () => {
    const sender = fakeSender();
    const result = await new PeerQualityController().applyVideo(
      fakePeer(),
      "screen:own",
      sender,
      "screen",
      { ...QUALITY_SETTINGS.balanced, maxBitrate: 300_000, maxFramerate: 8 },
      "low",
      false,
    );
    expect(result).toBe("available");
    expect(sender.setParameters).toHaveBeenCalledWith({
      degradationPreference: "maintain-resolution",
      encodings: [{
        active: true,
        maxBitrate: 300_000,
        maxFramerate: 8,
        scaleResolutionDownBy: 2,
        priority: "low",
        networkPriority: "low",
      }],
    });
  });

  it("keeps low and medium simulcast layers active for an individual balanced subscription ceiling", async () => {
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const sender = {
      track: { kind: "video" },
      getParameters: vi.fn(() => ({
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      } as unknown as RTCRtpSendParameters)),
      setParameters,
    } as unknown as RTCRtpSender;
    const result = await new PeerQualityController().applyVideo(
      fakePeer(),
      "camera:agent",
      sender,
      "camera",
      QUALITY_SETTINGS.balanced,
      "medium",
      false,
    );
    expect(result).toBe("available");
    const encodings = setParameters.mock.calls[0][0].encodings;
    expect(encodings.map(({ rid, active, maxBitrate, maxFramerate, scaleResolutionDownBy }: RTCRtpEncodingParameters) => ({
      rid, active, maxBitrate, maxFramerate, scaleResolutionDownBy,
    }))).toEqual([
      { rid: "q", active: true, maxBitrate: 120_000, maxFramerate: 6, scaleResolutionDownBy: 4 },
      { rid: "h", active: true, maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
      { rid: "f", active: false, maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 1 },
    ]);
  });

  it("falls back to local priority when network priority is rejected", async () => {
    const setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
      if (parameters.encodings[0].networkPriority) throw new DOMException("unsupported", "InvalidModificationError");
    });
    const sender = fakeSender(setParameters);
    const peer = fakePeer();
    const result = await new PeerQualityController().applyAudio(
      peer,
      "microphone:own",
      sender,
      { priority: "medium", maxBitrate: 48_000 },
      false,
    );
    expect(result).toBe("degraded");
    expect(setParameters).toHaveBeenCalledTimes(2);
    expect(setParameters.mock.calls[1][0].encodings[0]).toEqual({
      active: true,
      maxBitrate: 48_000,
      priority: "medium",
    });
    expect(peer.appliedTiers.has("microphone:own")).toBe(true);
  });
});
