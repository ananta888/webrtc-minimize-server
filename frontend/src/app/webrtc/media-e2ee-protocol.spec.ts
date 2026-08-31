import { describe, expect, it } from "vitest";

import {
  createMediaKeyAck,
  createMediaKeyMessage,
  decodeMediaBaseKey,
  parseMediaE2eeMessage,
} from "./media-e2ee-protocol";

const input = {
  publicationId: "{4afe877a-4644-44d0-85f4-bee3af582e89}",
  senderPeerId: "0123456789abcdef",
  membershipEpoch: 3,
  keyId: "0011223344556677",
  baseKey: Uint8Array.from({ length: 16 }, (_, index) => index),
};

describe("media E2EE overlay contract", () => {
  it("round-trips exact key and acknowledgement envelopes", () => {
    const key = createMediaKeyMessage(input);
    expect(parseMediaE2eeMessage(JSON.parse(JSON.stringify(key)))).toEqual(key);
    expect(decodeMediaBaseKey(key)).toEqual(input.baseKey);
    expect(parseMediaE2eeMessage(createMediaKeyAck(key))).toEqual(createMediaKeyAck(key));
  });

  it("rejects unknown fields, malformed keys and unsafe epochs", () => {
    const key = createMediaKeyMessage(input);
    expect(parseMediaE2eeMessage({ ...key, leakedSecret: true })).toBeNull();
    expect(parseMediaE2eeMessage({ ...key, baseKey: "short" })).toBeNull();
    expect(parseMediaE2eeMessage({ ...key, membershipEpoch: 0 })).toBeNull();
    expect(parseMediaE2eeMessage({ ...createMediaKeyAck(key), keyId: "ABC" })).toBeNull();
  });
});
