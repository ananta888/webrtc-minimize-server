import { describe, expect, it } from "vitest";

import { decodeWhiteboardBytes, encodeWhiteboardOperation, parseWhiteboardOperation } from "./whiteboard-contract";

const op = {
  version: 1 as const, type: "whiteboard-op" as const, opId: "a".repeat(32), membershipEpoch: 2,
  authorPeerId: "aaaaaaaaaaaaaaaa", kind: "stroke-begin" as const,
  payload: { color: "ink", width: 2, point: { x: 1, y: -2 } },
};

describe("whiteboard contract", () => {
  it("round-trips bounded operations and rejects HTML extras", () => {
    expect(parseWhiteboardOperation(op)?.kind).toBe("stroke-begin");
    const bytes = encodeWhiteboardOperation(op);
    expect(decodeWhiteboardBytes(bytes)?.payload).toEqual(op.payload);
    expect(parseWhiteboardOperation({ ...op, extra: true })).toBeNull();
    expect(parseWhiteboardOperation({ ...op, kind: "script" })).toBeNull();
    expect(parseWhiteboardOperation({
      ...op, kind: "stroke-point", payload: { points: [{ x: 0, y: 0, html: "<svg>" }] },
    })).toBeNull();
  });

  it("handles shapes, text, sync-request, and sync-response", () => {
    const shapeOp = {
      ...op,
      kind: "shape" as const,
      payload: { shape: "rectangle" as const, color: "accent" as const, width: 3, start: { x: 10, y: 20 }, end: { x: 50, y: 60 } },
    };
    const parsedShape = parseWhiteboardOperation(shapeOp);
    expect(parsedShape?.kind).toBe("shape");
    expect(decodeWhiteboardBytes(encodeWhiteboardOperation(shapeOp))?.payload).toEqual(shapeOp.payload);

    // Text op
    const textOp = {
      ...op,
      kind: "text" as const,
      payload: { text: "Annotated note", point: { x: 100, y: 200 }, color: "mark" as const, size: 18 },
    };
    const parsedText = parseWhiteboardOperation(textOp);
    expect(parsedText?.kind).toBe("text");
    expect(decodeWhiteboardBytes(encodeWhiteboardOperation(textOp))?.payload).toEqual(textOp.payload);

    // Text control characters rejected
    expect(parseWhiteboardOperation({
      ...textOp,
      payload: { ...textOp.payload, text: "Bad\x1bEscape" },
    })).toBeNull();

    // Sync-request
    const reqOp = { ...op, kind: "sync-request" as const, payload: {} };
    expect(parseWhiteboardOperation(reqOp)?.kind).toBe("sync-request");

    // Sync-response
    const respOp = {
      ...op,
      kind: "sync-response" as const,
      payload: { ops: [shapeOp, textOp] },
    };
    const parsedResp = parseWhiteboardOperation(respOp);
    expect(parsedResp?.kind).toBe("sync-response");
    expect(decodeWhiteboardBytes(encodeWhiteboardOperation(respOp))?.payload).toEqual(respOp.payload);

    // Nested sync ops rejected in sync-response
    expect(parseWhiteboardOperation({
      ...respOp,
      payload: { ops: [reqOp] },
    })).toBeNull();
  });

  it("handles laser pointer operation with point payload", () => {
    const laserOp = {
      ...op,
      kind: "laser" as const,
      payload: { point: { x: 350, y: 720 } },
    };
    const parsed = parseWhiteboardOperation(laserOp);
    expect(parsed?.kind).toBe("laser");
    expect(parsed?.payload).toEqual({ point: { x: 350, y: 720 } });
    const bytes = encodeWhiteboardOperation(laserOp);
    expect(decodeWhiteboardBytes(bytes)?.payload).toEqual({ point: { x: 350, y: 720 } });

    // Rejects invalid points or extra payload
    expect(parseWhiteboardOperation({ ...laserOp, payload: { point: { x: "bad", y: 0 } } })).toBeNull();
    expect(parseWhiteboardOperation({ ...laserOp, payload: { point: { x: 0, y: 0 }, extra: true } })).toBeNull();
  });
});


