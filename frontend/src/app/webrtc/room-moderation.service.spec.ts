import { describe, expect, it } from "vitest";

import { RoomModerationService } from "./room-moderation.service";
import { SignalingService } from "./signaling.service";

describe("RoomModerationService", () => {
  it("accepts closed snapshots and ignores unknown fields or role promotions", () => {
    const signaling = { subscribe(handler: (message: never) => void) { return () => handler; } } as unknown as SignalingService;
    const service = new RoomModerationService(signaling);
    service.bind("aaaaaaaaaaaaaaaa");
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 3,
      participants: [{ peerId: "aaaaaaaaaaaaaaaa", role: "participant", hand: "raised" }],
    });
    expect(service.ownHand()).toBe(true);
    expect(service.ownRole()).toBe("participant");
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 4,
      participants: [{ peerId: "aaaaaaaaaaaaaaaa", role: "owner", hand: "none", extra: true }],
    } as never);
    expect(service.ownHand()).toBe(true);
    expect(service.membershipEpoch()).toBe(3);
    service.reset();
    expect(service.participants()).toEqual([]);
  });
});
