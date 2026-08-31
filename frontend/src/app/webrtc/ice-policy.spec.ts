import { describe, expect, it } from "vitest";

import { cumulativeIceServers, parseIceTierPolicy } from "./ice-policy";

const valid = {
  version: 1,
  directIceServers: [{ urls: "stun:stun.example:3478" }],
  peerRelayIceServers: [{
    urls: ["turn:edge.example:3478?transport=udp", "turn:edge.example:3478?transport=tcp"],
    username: "1000:opaque",
    credential: "temporary",
    credentialType: "password",
  }],
  infrastructureRelayIceServers: [{ urls: "turns:turn.example:5349", username: "u", credential: "p" }],
  peerRelayAfterMs: 4_000,
  infrastructureRelayAfterMs: 9_000,
};

describe("ICE tier policy", () => {
  it("accepts a closed direct, peer-edge and infrastructure relay policy", () => {
    const policy = parseIceTierPolicy(valid);
    expect(policy).not.toBeNull();
    expect(cumulativeIceServers(policy!, 0)).toHaveLength(1);
    expect(cumulativeIceServers(policy!, 1)).toHaveLength(2);
    expect(cumulativeIceServers(policy!, 2)).toHaveLength(3);
  });

  it("rejects unknown fields, mixed schemes and unsafe fallback timing", () => {
    expect(parseIceTierPolicy({ ...valid, secret: "leak" })).toBeNull();
    expect(parseIceTierPolicy({ ...valid, peerRelayIceServers: [{ urls: "stun:not-a-relay" }] })).toBeNull();
    expect(parseIceTierPolicy({ ...valid, infrastructureRelayAfterMs: 4_000 })).toBeNull();
    expect(parseIceTierPolicy({ ...valid, directIceServers: [{ urls: "https://not-ice" }] })).toBeNull();
  });
});
