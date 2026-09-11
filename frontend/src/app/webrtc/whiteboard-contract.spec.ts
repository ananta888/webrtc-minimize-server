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
});
