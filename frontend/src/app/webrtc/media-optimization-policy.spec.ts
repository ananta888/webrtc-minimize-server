import { describe, expect, it } from "vitest";

import {
  classifyLinkStats,
  selectActiveSpeakers,
  selectVideoQuality,
  stabilizeLinkClass,
} from "./media-optimization-policy";

describe("media optimization policy", () => {
  it("keeps recent speakers stable while ranking stronger activity first", () => {
    const speakers = selectActiveSpeakers([
      { peerId: "ada", level: 0.2, observedAt: 1_000 },
      { peerId: "grace", level: 0.25, observedAt: 1_000 },
      { peerId: "linus", level: 0.01, observedAt: 1_000 },
    ], ["ada", "linus"], 1_100, 2);
    expect(speakers).toEqual(["ada", "grace"]);
  });

  it("prioritizes screen and top speakers and pauses idle video in large rooms", () => {
    expect(selectVideoQuality({ source: "screen", speakerRank: -1, participantCount: 20, mode: "auto", linkClass: "good", screenActive: true }).tier).toBe("screen");
    expect(selectVideoQuality({ source: "camera", speakerRank: 0, participantCount: 20, mode: "auto", linkClass: "good", screenActive: false }).tier).toBe("focus");
    expect(selectVideoQuality({ source: "camera", speakerRank: 4, participantCount: 20, mode: "auto", linkClass: "good", screenActive: false }).tier).toBe("balanced");
    expect(selectVideoQuality({ source: "camera", speakerRank: -1, participantCount: 20, mode: "auto", linkClass: "good", screenActive: false }).tier).toBe("paused");
    expect(selectVideoQuality({ source: "camera", speakerRank: -1, participantCount: 20, mode: "balanced", linkClass: "good", screenActive: false }).tier).toBe("thumbnail");
  });

  it("only degrades quality when link evidence worsens", () => {
    expect(classifyLinkStats({ availableOutgoingBitrate: 2_000_000, roundTripTime: 0.05, lossRatio: 0 })).toBe("good");
    expect(classifyLinkStats({ availableOutgoingBitrate: 700_000 })).toBe("constrained");
    expect(classifyLinkStats({ lossRatio: 0.2 })).toBe("critical");
    expect(selectVideoQuality({ source: "camera", speakerRank: 0, participantCount: 6, mode: "auto", linkClass: "critical", screenActive: false }).tier).toBe("thumbnail");
  });

  it("degrades immediately but requires dwell before link recovery", () => {
    expect(stabilizeLinkClass({ current: "good", candidate: "critical", candidateSince: 1_000, now: 1_100 }).value).toBe("critical");
    expect(stabilizeLinkClass({ current: "critical", candidate: "good", candidateSince: 1_000, now: 6_999 }).value).toBe("critical");
    expect(stabilizeLinkClass({ current: "critical", candidate: "good", candidateSince: 1_000, now: 7_000 }).value).toBe("good");
  });
});
