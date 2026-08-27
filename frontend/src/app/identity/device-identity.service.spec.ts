import { describe, expect, it } from "vitest";

import { deviceProofMessage } from "./device-identity.service";

describe("deviceProofMessage", () => {
  it("binds every normalized join field in a stable order", () => {
    expect(deviceProofMessage({
      roomId: "pair-alpha",
      mode: "pair",
      displayName: "Ada",
    }, 1234, "nonce-value-123456")).toBe(
      "webrtc-join-v1\npair-alpha\npair\nAda\n1234\nnonce-value-123456",
    );
  });
});
