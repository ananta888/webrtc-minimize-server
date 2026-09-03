import { describe, expect, it } from "vitest";

import { mediaAgentCandidateMatchesDescription, mediaAgentIceUfrags } from "./media-agent-ice-generation";

describe("media-agent ICE generations", () => {
  const description = {
    type: "offer" as const,
    sdp: "v=0\r\na=ice-ufrag:session\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:data\r\n",
  };

  it("extracts every authenticated ICE username fragment", () => {
    expect([...mediaAgentIceUfrags(description)]).toEqual(["session", "data"]);
  });

  it("keeps a future-generation candidate queued until its description arrives", () => {
    expect(mediaAgentCandidateMatchesDescription({ candidate: "candidate:1", usernameFragment: "future" }, description)).toBe(false);
    expect(mediaAgentCandidateMatchesDescription({ candidate: "candidate:1", usernameFragment: "data" }, description)).toBe(true);
  });

  it("accepts legacy and end-of-candidates records only after a description exists", () => {
    expect(mediaAgentCandidateMatchesDescription({ candidate: "candidate:1" }, description)).toBe(true);
    expect(mediaAgentCandidateMatchesDescription(null, description)).toBe(true);
    expect(mediaAgentCandidateMatchesDescription(null, null)).toBe(false);
  });
});
