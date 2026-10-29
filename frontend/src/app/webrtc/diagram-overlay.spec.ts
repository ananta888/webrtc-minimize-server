import { describe, expect, it } from "vitest";

import { encodeDiagramOperation, parseDiagramOperation, DiagramOperation } from "./diagram-contract";
import {
  applyDiagramLock,
  authorizedDiagramEditorPeerIds,
  diagramDocFromOperation,
  diagramToolStateFromOperation,
  ingestDiagramDelivery,
  pruneDiagramLocks,
  winsDiagramLww,
} from "./diagram-overlay";

const PEER_A = "a".repeat(16);
const PEER_B = "b".repeat(16);

function op(overrides: Record<string, unknown>): DiagramOperation {
  const parsed = parseDiagramOperation({
    version: 1,
    type: "diagram-op",
    opId: "c".repeat(32),
    membershipEpoch: 2,
    authorPeerId: PEER_A,
    ...overrides,
  });
  if (!parsed) throw new Error("fixture_operation_invalid");
  return parsed;
}

function delivery(operation: DiagramOperation, trafficClass: string, originPeerId = operation.authorPeerId) {
  return { originPeerId, trafficClass, data: encodeDiagramOperation(operation) };
}

function ctx(seen: ReadonlySet<string> = new Set(), known = new Set([PEER_A, PEER_B])) {
  return { membershipEpoch: 2, knownPeerIds: known, seen };
}

describe("diagram overlay ingest", () => {
  it("accepts matching traffic classes and rejects mismatches", () => {
    const snapshot = op({ kind: "snapshot", payload: { tool: "bpmn", xml: "<a/>", revision: 1 } });
    expect(ingestDiagramDelivery(delivery(snapshot, "bulk"), ctx())).not.toBeNull();
    expect(ingestDiagramDelivery(delivery(snapshot, "event"), ctx())).toBeNull();
    const lock = op({ kind: "lock", payload: { elementId: "Activity_1", locked: true } });
    expect(ingestDiagramDelivery(delivery(lock, "event"), ctx())).not.toBeNull();
    expect(ingestDiagramDelivery(delivery(lock, "bulk"), ctx())).toBeNull();
    expect(ingestDiagramDelivery(delivery(lock, "machine"), ctx())).toBeNull();
  });

  it("fails closed on epoch, author, membership and replay", () => {
    const snapshot = op({ kind: "snapshot", payload: { tool: "bpmn", xml: "<a/>", revision: 1 } });
    expect(ingestDiagramDelivery(delivery(snapshot, "bulk"), { ...ctx(), membershipEpoch: 3 })).toBeNull();
    expect(ingestDiagramDelivery(delivery(snapshot, "bulk", PEER_B), ctx())).toBeNull();
    expect(ingestDiagramDelivery(delivery(snapshot, "bulk"), ctx(new Set(), new Set([PEER_B])))).toBeNull();
    expect(ingestDiagramDelivery(delivery(snapshot, "bulk"), ctx(new Set(["c".repeat(32)])))).toBeNull();
  });
});

describe("diagram overlay last-writer-wins", () => {
  it("prefers higher revisions, breaks ties by author and keeps the incumbent otherwise", () => {
    const first = diagramDocFromOperation(op({
      kind: "snapshot", payload: { tool: "bpmn", xml: "<a/>", revision: 5 },
    }))!;
    expect(winsDiagramLww(null, first)).toBe(true);
    const older = diagramDocFromOperation(op({
      kind: "snapshot", payload: { tool: "bpmn", xml: "<b/>", revision: 4 },
    }))!;
    expect(winsDiagramLww(first, older)).toBe(false);
    const newer = diagramDocFromOperation(op({
      kind: "snapshot", payload: { tool: "bpmn", xml: "<c/>", revision: 6 },
    }))!;
    expect(winsDiagramLww(first, newer)).toBe(true);
    const tieLowerAuthor = { ...first, authorPeerId: "0".repeat(16) };
    expect(winsDiagramLww(first, tieLowerAuthor)).toBe(false);
    const tieHigherAuthor = { ...first, authorPeerId: "f".repeat(16) };
    expect(winsDiagramLww(first, tieHigherAuthor)).toBe(true);
    expect(winsDiagramLww(first, { ...first })).toBe(false);
  });

  it("derives tool state from tool operations and keeps the document author on relayed sync responses", () => {
    const toolOp = op({ kind: "tool", payload: { tool: "drawio", revision: 3 } });
    expect(diagramToolStateFromOperation(toolOp)).toEqual({
      tool: "drawio", revision: 3, authorPeerId: PEER_A,
    });
    expect(diagramToolStateFromOperation(op({ kind: "lock", payload: { elementId: "a", locked: true } }))).toBeNull();
    const relayed = op({
      kind: "sync-response",
      payload: { tool: "bpmn", xml: "<a/>", revision: 5, docAuthor: PEER_B },
    });
    expect(diagramDocFromOperation(relayed)).toEqual({
      tool: "bpmn", xml: "<a/>", revision: 5, authorPeerId: PEER_B,
    });
  });
});

describe("diagram overlay locks", () => {
  it("claims, refreshes and releases only for the lock owner", () => {
    let locks = applyDiagramLock(new Map(), op({ kind: "lock", payload: { elementId: "Task_1", locked: true } }), 1_000);
    expect(locks.get("Task_1")).toEqual({ ownerPeerId: PEER_A, expiresAt: 1_000 + 60_000 });

    const foreignClaim = { ...op({ kind: "lock", payload: { elementId: "Task_1", locked: true } }), authorPeerId: PEER_B };
    locks = applyDiagramLock(locks, foreignClaim, 2_000);
    expect(locks.get("Task_1")?.ownerPeerId).toBe(PEER_A);

    const foreignRelease = { ...op({ kind: "lock", payload: { elementId: "Task_1", locked: false } }), authorPeerId: PEER_B };
    locks = applyDiagramLock(locks, foreignRelease, 3_000);
    expect(locks.has("Task_1")).toBe(true);

    locks = applyDiagramLock(locks, op({ kind: "lock", payload: { elementId: "Task_1", locked: false } }), 4_000);
    expect(locks.has("Task_1")).toBe(false);
  });

  it("lets expired locks be retaken and prunes stale entries", () => {
    let locks = applyDiagramLock(new Map(), op({ kind: "lock", payload: { elementId: "Task_1", locked: true } }), 1_000);
    const afterExpiry = 1_000 + 60_000 + 1;
    const foreignClaim = { ...op({ kind: "lock", payload: { elementId: "Task_1", locked: true } }), authorPeerId: PEER_B };
    locks = applyDiagramLock(locks, foreignClaim, afterExpiry);
    expect(locks.get("Task_1")?.ownerPeerId).toBe(PEER_B);
    expect(pruneDiagramLocks(locks, afterExpiry + 60_000 + 1).size).toBe(0);
    expect(pruneDiagramLocks(locks, afterExpiry).size).toBe(1);
  });
});

describe("diagram overlay authorization", () => {
  const participants = [
    { peerId: PEER_A, role: "owner" },
    { peerId: PEER_B, role: "participant" },
  ];

  it("allows everyone in open mode and only owner/presenter otherwise", () => {
    const known = new Set([PEER_A, PEER_B]);
    expect(authorizedDiagramEditorPeerIds(participants, "", "open", known)).toBe(known);
    expect(authorizedDiagramEditorPeerIds(participants, "", "presenter-only", known)).toEqual(new Set([PEER_A]));
    expect(authorizedDiagramEditorPeerIds(participants, PEER_B, "presenter-only", known))
      .toEqual(new Set([PEER_A, PEER_B]));
    expect(authorizedDiagramEditorPeerIds(participants, "f".repeat(16), "presenter-only", known))
      .toEqual(new Set([PEER_A]));
  });
});
