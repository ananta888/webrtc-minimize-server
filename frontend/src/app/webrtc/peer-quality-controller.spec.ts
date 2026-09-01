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
