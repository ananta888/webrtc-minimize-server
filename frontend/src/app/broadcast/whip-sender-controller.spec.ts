import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WHIP_SENDER_POLICY,
  WhipAdaptiveSenderController,
  normalizeWhipSenderPolicy,
} from "./whip-sender-controller";

function track(kind: "audio" | "video"): MediaStreamTrack {
  return Object.assign(new EventTarget(), { kind, readyState: "live", contentHint: "" }) as MediaStreamTrack;
}

function sender(mediaTrack: MediaStreamTrack, encodings: RTCRtpEncodingParameters[] = [{}]) {
  let parameters = { encodings: encodings.map((encoding) => ({ ...encoding })) } as RTCRtpSendParameters;
  return {
    track: mediaTrack,
    getParameters: vi.fn(() => structuredClone(parameters)),
    setParameters: vi.fn(async (next: RTCRtpSendParameters) => { parameters = structuredClone(next); }),
    current: () => parameters,
  };
}

function report(values: readonly Record<string, unknown>[]): RTCStatsReport {
  return new Map(values.map((value, index) => [String(index), value])) as unknown as RTCStatsReport;
}

describe("WhipAdaptiveSenderController", () => {
  it("applies bounded source-specific audio, camera, screen and simulcast envelopes", async () => {
    const video = track("video");
    const videoSender = sender(video, [
      { rid: "q", scaleResolutionDownBy: 4 },
      { rid: "f", scaleResolutionDownBy: 1 },
    ]);
    const controller = new WhipAdaptiveSenderController({} as RTCPeerConnection, [{
      descriptor: {
        sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "screen", envelope: "clear-program-v1", track: video,
      },
      sender: videoSender as unknown as RTCRtpSender,
    }]);
    expect(await controller.apply()).toBe(true);
    expect(video.contentHint).toBe("detail");
    expect(videoSender.current().degradationPreference).toBe("maintain-resolution");
    expect(videoSender.current().encodings).toEqual([
      expect.objectContaining({ active: true, maxBitrate: 500_000, maxFramerate: 15, priority: "high" }),
      expect.objectContaining({ active: true, maxBitrate: 2_000_000, maxFramerate: 15, priority: "high" }),
    ]);

    const audio = track("audio");
    const audioSender = sender(audio);
    const audioController = new WhipAdaptiveSenderController({} as RTCPeerConnection, [{
      descriptor: {
        sourceId: "src_bbbbbbbbbbbbbbbb", sourceKind: "microphone", envelope: "clear-program-v1", track: audio,
      },
      sender: audioSender as unknown as RTCRtpSender,
    }]);
    await audioController.apply();
    expect(audioSender.current().encodings[0].maxBitrate).toBe(48_000);
    expect(audioSender.current().encodings[0].priority).toBe("high");
  });

  it("requires sustained pressure and cooldown before reducing or recovering quality", async () => {
    let now = 1_000_000;
    let bytesSent = 0;
    let packetsSent = 0;
    let packetsLost = 0;
    let framesEncoded = 0;
    let totalEncodeTime = 0;
    let constrained = false;
    const pc = {
      getStats: vi.fn(async () => {
        bytesSent += 100_000;
        packetsSent += 100;
        packetsLost += constrained ? 12 : 0;
        framesEncoded += constrained ? 0 : 30;
        totalEncodeTime += constrained ? 1.8 : 0.2;
        return report([
          { type: "outbound-rtp", kind: "video", bytesSent, packetsSent, framesEncoded, totalEncodeTime },
          { type: "remote-inbound-rtp", packetsLost, roundTripTime: constrained ? 0.5 : 0.05 },
          {
            type: "candidate-pair", selected: true, state: "succeeded",
            availableOutgoingBitrate: constrained ? 100_000 : 5_000_000,
          },
        ]);
      }),
    } as unknown as RTCPeerConnection;
    const mediaTrack = track("video");
    const mediaSender = sender(mediaTrack);
    const controller = new WhipAdaptiveSenderController(pc, [{
      descriptor: {
        sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "camera", envelope: "clear-program-v1", track: mediaTrack,
      },
      sender: mediaSender as unknown as RTCRtpSender,
    }], DEFAULT_WHIP_SENDER_POLICY, () => now);
    expect((await controller.sample()).reasonCode).toBe("warming");
    constrained = true;
    for (let index = 0; index < 2; index += 1) {
      now += 2_000;
      expect((await controller.sample()).transitioned).toBe(false);
    }
    now += 2_000;
    expect(await controller.sample()).toMatchObject({
      transitioned: true, level: "medium", reasonCode: "quality-reduced", framesEncodedDelta: 0,
    });
    expect(mediaSender.current().encodings[0].maxBitrate).toBe(780_000);

    constrained = false;
    for (let index = 0; index < 4; index += 1) {
      now += 2_000;
      expect((await controller.sample()).transitioned).toBe(false);
    }
    now += 2_000;
    expect(await controller.sample()).toMatchObject({
      transitioned: true, level: "high", reasonCode: "quality-recovered",
    });
  });

  it("validates hysteresis order and fails visibly after close", async () => {
    expect(() => normalizeWhipSenderPolicy({
      ...DEFAULT_WHIP_SENDER_POLICY,
      recoverPacketLoss: DEFAULT_WHIP_SENDER_POLICY.degradePacketLoss,
    })).toThrow("invalid_whip_sender_policy");
    const mediaTrack = track("audio");
    const controller = new WhipAdaptiveSenderController({} as RTCPeerConnection, [{
      descriptor: {
        sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "silence", envelope: "clear-program-v1", track: mediaTrack,
      },
      sender: sender(mediaTrack) as unknown as RTCRtpSender,
    }]);
    controller.close();
    await expect(controller.sample()).rejects.toThrow("whip_sender_controller_closed");
    expect(await controller.apply()).toBe(false);
  });
});
