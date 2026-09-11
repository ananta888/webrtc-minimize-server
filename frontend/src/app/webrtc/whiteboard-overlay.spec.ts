import { describe, expect, it } from "vitest";

import { encodeWhiteboardOperation } from "./whiteboard-contract";
import {
  appendWhiteboardOperation,
  ingestWhiteboardDelivery,
  undoOwnWhiteboardOperations,
} from "./whiteboard-overlay";

const op = {
  version: 1 as const, type: "whiteboard-op" as const, opId: "a".repeat(32), membershipEpoch: 2,
  authorPeerId: "aaaaaaaaaaaaaaaa", kind: "stroke-begin" as const,
  payload: { color: "ink" as const, width: 2, point: { x: 1, y: 2 } },
};

describe("whiteboard overlay ingest", () => {
  it("accepts event-class ops from the overlay origin and rejects spoofed authors or stale epochs", () => {
    const bytes = encodeWhiteboardOperation(op);
    const delivery = { originPeerId: "aaaaaaaaaaaaaaaa", trafficClass: "event", data: bytes };
    const known = new Set(["aaaaaaaaaaaaaaaa"]);
    expect(ingestWhiteboardDelivery(delivery, { membershipEpoch: 2, knownPeerIds: known, seen: new Set() })?.opId).toBe(op.opId);
    expect(ingestWhiteboardDelivery({ ...delivery, originPeerId: "bbbbbbbbbbbbbbbb" }, {
      membershipEpoch: 2, knownPeerIds: known, seen: new Set(),
    })).toBeNull();
    expect(ingestWhiteboardDelivery(delivery, { membershipEpoch: 3, knownPeerIds: known, seen: new Set() })).toBeNull();
    expect(ingestWhiteboardDelivery({ ...delivery, trafficClass: "bulk" }, {
      membershipEpoch: 2, knownPeerIds: known, seen: new Set(),
    })).toBeNull();
  });

  it("deduplicates, bounds history and undoes only own trailing strokes", () => {
    const first = appendWhiteboardOperation([], op);
    expect(appendWhiteboardOperation(first, op)).toEqual(first);
    const ownEnd = { ...op, opId: "b".repeat(32), kind: "stroke-end" as const, payload: { point: { x: 3, y: 4 } } };
    const other = { ...op, opId: "c".repeat(32), authorPeerId: "bbbbbbbbbbbbbbbb" };
    const stacked = appendWhiteboardOperation(appendWhiteboardOperation(first, other), ownEnd);
    expect(undoOwnWhiteboardOperations(stacked, "aaaaaaaaaaaaaaaa").map((item) => item.opId)).toEqual([op.opId, other.opId]);
  });
});
