import { describe, expect, it } from "vitest";

import { parseMediaAgentRemoteTrackBindings } from "./media-agent-sdp";

describe("media-agent SDP track bindings", () => {
  it("extracts only bounded remote-sending media identities by MID", () => {
    const bindings = parseMediaAgentRemoteTrackBindings([
      "v=0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "a=mid:0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:1",
      "a=sendonly",
      "a=msid:fedcba9876543210 camera-track",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:2",
      "a=sendrecv",
      "a=msid:fedcba9876543210 microphone-track",
      "m=video 0 UDP/TLS/RTP/SAVPF 96",
      "a=mid:3",
      "a=sendonly",
      "a=msid:fedcba9876543210 removed-screen",
      "",
    ].join("\r\n"));

    expect([...bindings!.entries()]).toEqual([
      ["1", {
        publisherPeerId: "fedcba9876543210",
        publicationId: "camera-track",
        kind: "video",
      }],
      ["2", {
        publisherPeerId: "fedcba9876543210",
        publicationId: "microphone-track",
        kind: "audio",
      }],
    ]);
  });

  it("leaves malformed or receiver-only identities unbound", () => {
    const bindings = parseMediaAgentRemoteTrackBindings([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:1",
      "a=recvonly",
      "a=msid:fedcba9876543210 camera-track",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:2",
      "a=sendonly",
      "a=msid:not-a-peer screen-track",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:3",
      "a=sendonly",
      "a=msid:fedcba9876543210 invalid publication id",
      "",
    ].join("\r\n"));

    expect([...bindings!.entries()]).toEqual([]);
    expect(parseMediaAgentRemoteTrackBindings("")).toBeNull();
    expect(parseMediaAgentRemoteTrackBindings("x".repeat(1_048_577))).toBeNull();
  });

  it("fails closed on conflicting duplicate MID identities", () => {
    const bindings = parseMediaAgentRemoteTrackBindings([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:7",
      "a=sendonly",
      "a=msid:fedcba9876543210 camera-track",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:7",
      "a=sendonly",
      "a=msid:aaaaaaaaaaaaaaaa other-camera",
      "",
    ].join("\r\n"));

    expect(bindings!.has("7")).toBe(false);
  });
});
