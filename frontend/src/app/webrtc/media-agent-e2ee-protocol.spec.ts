import { describe, expect, it } from "vitest";

import {
  createMediaAgentKeyAck,
  createMediaAgentKeyMessage,
  decodeMediaAgentBaseKey,
  parseMediaAgentE2eeMessage,
} from "./media-agent-e2ee-protocol";

const input = {
  publicationId: "screen-track",
  senderPeerId: "0123456789abcdef",
  agentId: "owner-edge",
  membershipEpoch: 9,
  routeEpoch: 12,
  keyId: "0011223344556677",
  baseKey: Uint8Array.from({ length: 16 }, (_, index) => 15 - index),
};

describe("media-agent group-key overlay contract", () => {
  it("round-trips a publication- and epoch-bound key plus acknowledgement", () => {
    const message = createMediaAgentKeyMessage(input);
    expect(parseMediaAgentE2eeMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(decodeMediaAgentBaseKey(message)).toEqual(input.baseKey);
    expect(parseMediaAgentE2eeMessage(createMediaAgentKeyAck(message))).toEqual(createMediaAgentKeyAck(message));
  });

  it("fails closed on agent, route, key and unknown-field changes", () => {
    const message = createMediaAgentKeyMessage(input);
    expect(parseMediaAgentE2eeMessage({ ...message, agentId: "UPPERCASE" })).toBeNull();
    expect(parseMediaAgentE2eeMessage({ ...message, routeEpoch: 0 })).toBeNull();
    expect(parseMediaAgentE2eeMessage({ ...message, baseKey: "short" })).toBeNull();
    expect(parseMediaAgentE2eeMessage({ ...message, version: 1 })).toBeNull();
    expect(parseMediaAgentE2eeMessage({ ...message, frameEnvelope: "legacy" })).toBeNull();
    expect(parseMediaAgentE2eeMessage({ ...message, decryptAtAgent: true })).toBeNull();
  });
});
