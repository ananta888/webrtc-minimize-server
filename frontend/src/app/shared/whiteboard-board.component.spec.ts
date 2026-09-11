import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { paintShapePreview, paintWhiteboard } from "./whiteboard-board.component";

const source = readFileSync("frontend/src/app/shared/whiteboard-board.component.ts", "utf8");

describe("WhiteboardBoardComponent", () => {
  it("paints canvas primitives only and never starts capture", () => {
    expect(source).toContain('id="whiteboard-canvas"');
    expect(source).toContain('id="whiteboard-tool-select"');
    expect(source).toContain('id="whiteboard-text-input"');
    expect(source).toContain("board.requestClear()");
    expect(source).toContain("board.undoOwn()");
    expect(source).toContain('id="whiteboard-export-png"');
    expect(source).toContain('id="whiteboard-export-pdf"');
    expect(source).toContain('id="whiteboard-prev-slide"');
    expect(source).toContain('id="whiteboard-next-slide"');
    expect(source).toContain('id="whiteboard-upload-button"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('@HostListener("window:keydown"');
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
      strokeRect: () => calls.push("strokeRect"),
      ellipse: () => calls.push("ellipse"),
      fillText: () => calls.push("fillText"),
      drawImage: () => calls.push("drawImage"),
      setLineDash: () => calls.push("setLineDash"),
      lineCap: "",
      lineJoin: "",
      strokeStyle: "",
      lineWidth: 0,
      globalCompositeOperation: "",
      fillStyle: "",
      font: "",
      textBaseline: "",
    };

    paintWhiteboard(ctx as never, [
      {
        version: 1,
        type: "whiteboard-op",
        opId: "a".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "aaaaaaaaaaaaaaaa",
        kind: "erase",
        payload: { point: { x: 10, y: 10 } },
      },
      {
        version: 1,
        type: "whiteboard-op",
        opId: "b".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "aaaaaaaaaaaaaaaa",
        kind: "shape",
        payload: { shape: "rectangle", color: "accent", width: 2, start: { x: 0, y: 0 }, end: { x: 50, y: 50 } },
      },
      {
        version: 1,
        type: "whiteboard-op",
        opId: "c".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "aaaaaaaaaaaaaaaa",
        kind: "shape",
        payload: { shape: "ellipse", color: "ink", width: 2, start: { x: 10, y: 10 }, end: { x: 60, y: 60 } },
      },
      {
        version: 1,
        type: "whiteboard-op",
        opId: "d".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "aaaaaaaaaaaaaaaa",
        kind: "shape",
        payload: { shape: "line", color: "mark", width: 2, start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
      },
      {
        version: 1,
        type: "whiteboard-op",
        opId: "e".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "aaaaaaaaaaaaaaaa",
        kind: "text",
        payload: { text: "Note", point: { x: 20, y: 20 }, color: "accent", size: 16 },
      },
    ]);
    expect(calls).toContain("arc");
    expect(calls).toContain("clear");
    expect(calls).toContain("strokeRect");
    expect(calls).toContain("ellipse");
    expect(calls).toContain("fillText");

    // Preview painting uses setLineDash
    paintShapePreview(ctx as never, "rectangle", { x: 0, y: 0 }, { x: 10, y: 10 }, "accent", 2);
    expect(calls).toContain("setLineDash");
  });

  it("renders background image when slide image is provided", () => {
    const calls: string[] = [];
    const ctx = {
      clearRect: () => calls.push("clear"),
      drawImage: () => calls.push("drawImage"),
      lineCap: "",
      lineJoin: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const fakeImg = {
      complete: true,
      naturalWidth: 800,
      naturalHeight: 600,
    } as unknown as HTMLImageElement;

    paintWhiteboard(ctx as never, [], fakeImg);
    expect(calls).toContain("drawImage");
    expect(calls).not.toContain("clear");
  });
});
