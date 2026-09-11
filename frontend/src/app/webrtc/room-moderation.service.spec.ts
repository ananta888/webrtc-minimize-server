import { describe, expect, it } from "vitest";

import { RoomModerationService } from "./room-moderation.service";
import { SignalingService } from "./signaling.service";

describe("RoomModerationService", () => {
  it("accepts closed snapshots with a server-authored FIFO queue and ignores unknown fields or role promotions", () => {
    const signaling = { subscribe(handler: (message: never) => void) { return () => handler; } } as unknown as SignalingService;
    const service = new RoomModerationService(signaling);
    service.bind("aaaaaaaaaaaaaaaa");
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 3,
      participants: [
        { peerId: "bbbbbbbbbbbbbbbb", role: "owner", hand: "raised", raisedAt: 20 },
        { peerId: "aaaaaaaaaaaaaaaa", role: "participant", hand: "raised", raisedAt: 10 },
      ],
      queue: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    });
    expect(service.ownHand()).toBe(true);
    expect(service.ownRole()).toBe("participant");
    expect(service.queue()).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(service.queuePosition()).toBe(1);
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 4,
      participants: [{ peerId: "aaaaaaaaaaaaaaaa", role: "owner", hand: "none", raisedAt: 0, extra: true }],
      queue: [],
    } as never);
    expect(service.ownHand()).toBe(true);
    expect(service.membershipEpoch()).toBe(3);
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 4,
      participants: [
        { peerId: "aaaaaaaaaaaaaaaa", role: "participant", hand: "raised", raisedAt: 30 },
        { peerId: "bbbbbbbbbbbbbbbb", role: "owner", hand: "raised", raisedAt: 10 },
      ],
      queue: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    });
    expect(service.queue()).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(service.membershipEpoch()).toBe(3);
    service.reset();
    expect(service.participants()).toEqual([]);
    expect(service.queue()).toEqual([]);
    expect(service.audit()).toEqual([]);
    expect(service.presenterPeerId()).toBe("");
    expect(service.pendingRemove()).toBeNull();
  });

  it("applies an authorized publication-stop locally and never starts capture", () => {
    const signaling = { subscribe(handler: (message: never) => void) { return () => handler; } } as unknown as SignalingService;
    const stopped: string[] = [];
    const media = { stop(source: string) { stopped.push(source); } };
    const service = new RoomModerationService(signaling, media as never);
    service.bind("aaaaaaaaaaaaaaaa");
    service.apply({
      version: 1, type: "publication-stop-request", membershipEpoch: 3,
      targetPeerId: "aaaaaaaaaaaaaaaa", source: "microphone",
    });
    expect(stopped).toEqual(["microphone"]);
    service.apply({
      version: 1, type: "publication-stop-request", membershipEpoch: 3,
      targetPeerId: "bbbbbbbbbbbbbbbb", source: "camera", extra: true,
    } as never);
    expect(stopped).toEqual(["microphone"]);
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 4,
      participants: [{ peerId: "aaaaaaaaaaaaaaaa", role: "owner", hand: "none", raisedAt: 0 }],
      queue: [],
      audit: [{
        sequence: 1, at: 9, actorPeerId: "aaaaaaaaaaaaaaaa", action: "publication-stop",
        targetPeerId: "bbbbbbbbbbbbbbbb", source: "camera",
      }],
    });
    expect(service.audit()).toEqual([{
      sequence: 1, at: 9, actorPeerId: "aaaaaaaaaaaaaaaa", action: "publication-stop",
      targetPeerId: "bbbbbbbbbbbbbbbb", source: "camera",
    }]);
  });

  it("handles whiteboardPolicy in snapshots and allows owner/presenter to set it", () => {
    const sent: unknown[] = [];
    const signaling = {
      subscribe(handler: (message: never) => void) { return () => handler; },
      send(message: unknown) { sent.push(message); },
    } as unknown as SignalingService;
    const service = new RoomModerationService(signaling);
    service.bind("aaaaaaaaaaaaaaaa");
    expect(service.whiteboardPolicy()).toBe("open");

    // Snapshot with presenter-only whiteboardPolicy
    service.apply({
      version: 1, type: "moderation-state", membershipEpoch: 5,
      participants: [
        { peerId: "aaaaaaaaaaaaaaaa", role: "owner", hand: "none", raisedAt: 0 },
        { peerId: "bbbbbbbbbbbbbbbb", role: "participant", hand: "none", raisedAt: 0 },
      ],
      queue: [],
      whiteboardPolicy: "presenter-only",
      audit: [{
        sequence: 1, at: 10, actorPeerId: "aaaaaaaaaaaaaaaa", action: "whiteboard-policy-set",
        targetPeerId: "aaaaaaaaaaaaaaaa", source: "presenter-only",
      }],
    });
    expect(service.whiteboardPolicy()).toBe("presenter-only");
    expect(service.canControlWhiteboard()).toBe(true);
    expect(service.audit().length).toBe(1);

    // Owner sets whiteboard policy
    service.setWhiteboardPolicy("open");
    expect(sent).toEqual([{ type: "whiteboard-policy-set", policy: "open" }]);

    // Reset clears policy to default "open"
    service.reset();
    expect(service.whiteboardPolicy()).toBe("open");
  });
});

