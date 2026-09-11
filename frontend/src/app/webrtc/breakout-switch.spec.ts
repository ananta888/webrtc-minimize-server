import { describe, expect, it } from "vitest";

import { offerBreakoutSwitch, parseBreakoutAssignment } from "./breakout-switch";

const assigned = {
  version: 1, type: "breakout-assigned", grantId: "aaaaaaaaaaaaaaaa", setId: "bbbbbbbbbbbbbbbb",
  childRoomId: "brk-abababababababababababab", parentRevision: 1, expiresAt: 90,
};

describe("breakout switch", () => {
  it("parses closed assignments and requires an explicit confirm before switching", () => {
    expect(parseBreakoutAssignment(assigned)?.childRoomId).toBe("brk-abababababababababababab");
    expect(parseBreakoutAssignment({ ...assigned, extra: true })).toBeNull();
    expect(offerBreakoutSwitch("idle", parseBreakoutAssignment(assigned), 10)).toBe("offered");
    expect(offerBreakoutSwitch("offered", parseBreakoutAssignment(assigned), 100)).toBe("idle");
    expect(offerBreakoutSwitch("switching", parseBreakoutAssignment(assigned), 100)).toBe("stranded");
  });
});
