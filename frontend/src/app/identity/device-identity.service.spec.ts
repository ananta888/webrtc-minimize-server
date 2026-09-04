import { describe, expect, it } from "vitest";

import { broadcastGrantProofMessage, deviceProofMessage } from "./device-identity.service";

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

describe("broadcastGrantProofMessage", () => {
  it("matches the server contract and canonicalizes action order", () => {
    expect(broadcastGrantProofMessage({
      tenantId: "tn_aaaaaaaaaaaaaaaa",
      subjectRef: "sub_bbbbbbbbbbbbbbbb",
      roomId: "room-alpha",
      programId: "prg_cccccccccccccccc",
      programRevision: 2,
      programEpoch: 3,
      grantKind: "playback",
      tokenAudience: "broadcast-playback",
      audienceRef: "sub_bbbbbbbbbbbbbbbb",
      resourceRef: "res_dddddddddddddddd",
      pathHash: "e".repeat(64),
      actions: ["playback:segment", "playback:manifest"],
    }, 1234, "nonce-value-123456")).toBe([
      "webrtc-broadcast-grant-v1",
      "tn_aaaaaaaaaaaaaaaa",
      "sub_bbbbbbbbbbbbbbbb",
      "room-alpha",
      "prg_cccccccccccccccc",
      "2",
      "3",
      "playback",
      "broadcast-playback",
      "sub_bbbbbbbbbbbbbbbb",
      "res_dddddddddddddddd",
      "e".repeat(64),
      "playback:manifest,playback:segment",
      "1234",
      "nonce-value-123456",
    ].join("\n"));
  });
});
