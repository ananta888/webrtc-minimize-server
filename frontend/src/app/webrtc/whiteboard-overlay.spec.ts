import { describe, expect, it } from "vitest";

import { encodeWhiteboardOperation } from "./whiteboard-contract";
import {
  appendWhiteboardOperation,
  boundSyncOps,
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

    // Shape undo is atomic
    const shapeOp = {
      ...op,
      opId: "d".repeat(32),
      kind: "shape" as const,
      payload: { shape: "rectangle" as const, color: "accent" as const, width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
    };
    const withShape = appendWhiteboardOperation(stacked, shapeOp);
    expect(undoOwnWhiteboardOperations(withShape, "aaaaaaaaaaaaaaaa").map((item) => item.opId)).toEqual(stacked.map((item) => item.opId));

    // Text undo is atomic
    const textOp = {
      ...op,
      opId: "e".repeat(32),
      kind: "text" as const,
      payload: { text: "Note", point: { x: 5, y: 5 }, color: "ink" as const, size: 14 },
    };
    const withText = appendWhiteboardOperation(stacked, textOp);
    expect(undoOwnWhiteboardOperations(withText, "aaaaaaaaaaaaaaaa").map((item) => item.opId)).toEqual(stacked.map((item) => item.opId));
  });

  it("bounds sync snapshot operations by count and byte size", () => {
    const ops = Array.from({ length: 100 }, (_, i) => ({
      ...op,
      opId: i.toString(16).padStart(32, "0"),
    }));

    const boundedByCount = boundSyncOps(ops, 64, 50 * 1024);
    expect(boundedByCount.length).toBe(64);
    expect(boundedByCount[boundedByCount.length - 1].opId).toBe(ops[ops.length - 1].opId);

    // Default maxBytes limits when byte size exceeds 11 KB
    const boundedByDefault = boundSyncOps(ops, 64);
    expect(boundedByDefault.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(boundedByDefault).length).toBeLessThan(11 * 1024);

    // Bounded by small maxBytes
    const tight = boundSyncOps(ops, 64, 500);
    expect(tight.length).toBeLessThan(5);

    // Filters out any nested sync ops
    const mixed = [
      { ...op, opId: "1".repeat(32), kind: "sync-request" as const, payload: {} },
      { ...op, opId: "2".repeat(32), kind: "shape" as const, payload: { shape: "line" as const, color: "ink" as const, width: 2, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
      { ...op, opId: "3".repeat(32), kind: "sync-response" as const, payload: { ops: [] } },
    ];
    const filtered = boundSyncOps(mixed, 64);
    expect(filtered.length).toBe(1);
    expect(filtered[0].kind).toBe("shape");
  });

  it("ingests sync-request and sync-response messages correctly", () => {
    const known = new Set(["aaaaaaaaaaaaaaaa"]);
    const reqOp = { ...op, kind: "sync-request" as const, payload: {} };
    const reqBytes = encodeWhiteboardOperation(reqOp);
    const reqDelivery = { originPeerId: "aaaaaaaaaaaaaaaa", trafficClass: "event", data: reqBytes };
    expect(ingestWhiteboardDelivery(reqDelivery, { membershipEpoch: 2, knownPeerIds: known, seen: new Set() })?.kind).toBe("sync-request");

    const respOp = {
      ...op,
      kind: "sync-response" as const,
      payload: { ops: [op] },
    };
    const respBytes = encodeWhiteboardOperation(respOp);
    const respDelivery = { originPeerId: "aaaaaaaaaaaaaaaa", trafficClass: "event", data: respBytes };
    const ingested = ingestWhiteboardDelivery(respDelivery, { membershipEpoch: 2, knownPeerIds: known, seen: new Set() });
    expect(ingested?.kind).toBe("sync-response");
    expect((ingested?.payload as { ops: unknown[] }).ops.length).toBe(1);
  });
});



