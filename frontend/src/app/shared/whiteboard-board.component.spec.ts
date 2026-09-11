import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { paintWhiteboard } from "./whiteboard-board.component";

const source = readFileSync("frontend/src/app/shared/whiteboard-board.component.ts", "utf8");

describe("WhiteboardBoardComponent", () => {
  it("paints canvas primitives only and never starts capture", () => {
    expect(source).toContain('id="whiteboard-canvas"');
    expect(source).toContain("board.requestClear()");
    expect(source).toContain("board.undoOwn()");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("getUserMedia");
    expect(source).not.toContain("getDisplayMedia");
    const calls: string[] = [];
    const ctx = {
      clearRect: () => calls.push("clear"),
      beginPath: () => calls.push("path"),
      moveTo: () => calls.push("move"),
      lineTo: () => calls.push("line"),
      stroke: () => calls.push("stroke"),
      arc: () => calls.push("arc"),
      fill: () => calls.push("fill"),
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      lineCap: "", lineJoin: "", strokeStyle: "", lineWidth: 0, globalCompositeOperation: "",
    };
    paintWhiteboard(ctx as never, [
      { version: 1, type: "whiteboard-op", opId: "a".repeat(32), membershipEpoch: 1,
        authorPeerId: "aaaaaaaaaaaaaaaa", kind: "erase", payload: { point: { x: 10, y: 10 } } },
    ]);
    expect(calls).toContain("arc");
    expect(calls).toContain("clear");
  });
});
