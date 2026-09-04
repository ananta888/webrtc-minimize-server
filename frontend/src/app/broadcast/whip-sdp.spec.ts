import { describe, expect, it } from "vitest";

import {
  applyWhipIceRestartAnswer,
  createWhipIceFragment,
  prepareWhipOffer,
  validateWhipAnswer,
} from "./whip-sdp";

const OFFER = [
  "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=ice-ufrag:localA",
  "a=ice-pwd:abcdefghijklmnopqrstuvwx", "a=setup:actpass", "a=mid:0",
  "a=sendonly", "a=msid:program-stream video-track", "a=rtcp-mux", "a=rtpmap:96 VP8/90000", "",
].join("\r\n");

const ANSWER = [
  "v=0", "o=- 2 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=ice-ufrag:remoteA",
  "a=ice-pwd:zyxwvutsrqponmlkjihgfedc", "a=setup:passive", "a=mid:0",
  "a=recvonly", "a=rtcp-mux", "a=rtcp-mux-only", "a=rtpmap:96 VP8/90000", "",
].join("\r\n");

const AUDIO_OFFER = [
  "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=ice-ufrag:localA",
  "a=ice-pwd:abcdefghijklmnopqrstuvwx", "a=setup:actpass", "a=mid:0",
  "a=sendonly", "a=msid:program-stream audio-track", "a=rtcp-mux", "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=0", "",
].join("\r\n");

describe("WHIP SDP boundary", () => {
  it("enforces max-bundle sendonly/recvonly and adds the RFC-required rtcp-mux-only offer attribute", () => {
    const offer = prepareWhipOffer(OFFER, 64 * 1024);
    expect(offer).toContain("a=rtcp-mux\r\na=rtcp-mux-only\r\n");
    expect(validateWhipAnswer(ANSWER, 64 * 1024)).toBe(ANSWER);
    const mediaMtxAnswer = ANSWER.replace("a=rtcp-mux-only\r\n", "");
    expect(() => validateWhipAnswer(mediaMtxAnswer, 64 * 1024)).toThrow("invalid_whip_answer_sdp");
    expect(validateWhipAnswer(mediaMtxAnswer, 64 * 1024, { allowMissingRtcpMuxOnly: true }))
      .toBe(mediaMtxAnswer);
    expect(() => prepareWhipOffer(OFFER.replace("a=sendonly", "a=recvonly"), 64 * 1024))
      .toThrow("invalid_whip_offer_sdp");
    expect(() => validateWhipAnswer(ANSWER.replace("m=video 9", "m=video 0"), 64 * 1024))
      .toThrow("invalid_whip_answer_sdp");
  });

  it("builds a bounded RFC-8840 fragment and rejects candidates for another bundled section", () => {
    const fragment = createWhipIceFragment(OFFER, [{
      candidate: "candidate:1 1 udp 2122260223 192.0.2.1 61764 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    }], true, 8 * 1024);
    expect(fragment).toContain("a=group:BUNDLE 0\r\n");
    expect(fragment).toContain("a=ice-ufrag:localA\r\n");
    expect(fragment).toContain("a=end-of-candidates\r\n");
    expect(() => createWhipIceFragment(OFFER, [{
      candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host",
      sdpMid: "other",
      sdpMLineIndex: 0,
    }], false, 8 * 1024)).toThrow("invalid_whip_ice_candidate");
  });

  it("applies a bounded Opus program profile without changing unrelated fmtp parameters", () => {
    const offer = prepareWhipOffer(AUDIO_OFFER, 64 * 1024, {
      policyVersion: 1, opusBitsPerSecond: 96_000, channelCount: 2, dtx: false, fec: true,
      priority: "high", contentHint: "speech",
    });
    expect(offer).toContain(
      "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=96000;stereo=1;sprop-stereo=1;usedtx=0\r\n",
    );
    expect(() => prepareWhipOffer(OFFER, 64 * 1024, {
      policyVersion: 1, opusBitsPerSecond: 96_000, channelCount: 1, dtx: true, fec: true,
      priority: "high", contentHint: "speech",
    })).toThrow("whip_audio_policy_without_audio");
  });

  it("applies only ICE restart fields to the previous answer", () => {
    const fragment = [
      "a=group:BUNDLE 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0",
      "a=ice-ufrag:remoteB", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
      "a=candidate:2 1 udp 1 198.51.100.2 50000 typ host", "a=end-of-candidates", "",
    ].join("\r\n");
    const updated = applyWhipIceRestartAnswer(ANSWER, fragment, 64 * 1024, 8 * 1024);
    expect(updated).toContain("a=ice-ufrag:remoteB");
    expect(updated).not.toContain("a=ice-ufrag:remoteA");
    expect(updated).toContain("a=rtpmap:96 VP8/90000");
    expect(() => applyWhipIceRestartAnswer(ANSWER, fragment.replace("remoteB", "bad value"), 64 * 1024, 8 * 1024))
      .toThrow("invalid_whip_ice_restart_response");
  });
});
