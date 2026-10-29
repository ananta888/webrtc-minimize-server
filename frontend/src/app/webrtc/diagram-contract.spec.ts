import { describe, expect, it } from "vitest";

import {
  decodeDiagramBytes,
  DIAGRAM_CONSTANTS,
  encodeDiagramOperation,
  parseDiagramOperation,
} from "./diagram-contract";

const base = {
  version: 1,
  type: "diagram-op",
  opId: "a".repeat(32),
  membershipEpoch: 3,
  authorPeerId: "b".repeat(16),
};

describe("diagram contract", () => {
  it("roundtrips snapshot, tool, lock and sync operations", () => {
    const snapshot = parseDiagramOperation({
      ...base,
      kind: "snapshot",
      payload: { tool: "bpmn", xml: "<definitions/>", revision: 7 },
    });
    expect(snapshot).not.toBeNull();
    expect(decodeDiagramBytes(encodeDiagramOperation(snapshot!))).toEqual(snapshot);

    const toolOp = parseDiagramOperation({ ...base, kind: "tool", payload: { tool: "drawio", revision: 4 } });
    expect(toolOp).not.toBeNull();
    expect(decodeDiagramBytes(encodeDiagramOperation(toolOp!))).toEqual(toolOp);

    const lock = parseDiagramOperation({
      ...base,
      kind: "lock",
      payload: { elementId: "Activity_1x:sub", locked: true },
    });
    expect(lock).not.toBeNull();

    expect(parseDiagramOperation({ ...base, kind: "sync-request", payload: {} })).not.toBeNull();
    expect(parseDiagramOperation({
      ...base,
      kind: "sync-response",
      payload: { tool: "bpmn", xml: "<a/>", revision: 2, docAuthor: "d".repeat(16) },
    })).not.toBeNull();
    expect(parseDiagramOperation({
      ...base,
      kind: "sync-response",
      payload: { tool: "bpmn", xml: "<a/>", revision: 2 },
    })).toBeNull();
    expect(parseDiagramOperation({
      ...base,
      kind: "sync-response",
      payload: { tool: "bpmn", xml: "<a/>", revision: 2, docAuthor: "not-a-peer" },
    })).toBeNull();
  });

  it("is fail-closed against unknown fields, kinds and malformed payloads", () => {
    expect(parseDiagramOperation({ ...base, kind: "snapshot", payload: { tool: "bpmn", xml: "<a/>", revision: 1 }, extra: 1 })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "script", payload: {} })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "snapshot", payload: { tool: "word", xml: "<a/>", revision: 1 } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "snapshot", payload: { tool: "bpmn", xml: "", revision: 1 } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "snapshot", payload: { tool: "bpmn", xml: "<a/>", revision: 0 } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "lock", payload: { elementId: "", locked: true } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "lock", payload: { elementId: "a".repeat(65), locked: true } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "lock", payload: { elementId: "a b", locked: true } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "sync-request", payload: { xml: "<a/>" } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "tool", payload: { tool: "bpmn" } })).toBeNull();
    expect(parseDiagramOperation({ ...base, kind: "tool", payload: { tool: "bpmn", revision: 0 } })).toBeNull();
    expect(parseDiagramOperation({ ...base, opId: "xyz", kind: "tool", payload: { tool: "bpmn", revision: 1 } })).toBeNull();
    expect(decodeDiagramBytes(new TextEncoder().encode("{not json"))).toBeNull();
  });

  it("bounds XML and encoded operations and refuses oversize input", () => {
    const oversizeXml = "<a/>" + "x".repeat(DIAGRAM_CONSTANTS.maxXmlBytes);
    expect(parseDiagramOperation({
      ...base,
      kind: "snapshot",
      payload: { tool: "bpmn", xml: oversizeXml, revision: 1 },
    })).toBeNull();
    expect(decodeDiagramBytes(new Uint8Array(DIAGRAM_CONSTANTS.maxEncodedBytes + 1))).toBeNull();
    expect(() => encodeDiagramOperation({
      ...base,
      kind: "snapshot",
      payload: { tool: "bpmn", xml: oversizeXml, revision: 1 },
    } as never)).toThrow("invalid_diagram_operation");
    const oversizeOpId = { ...base, kind: "tool", payload: { tool: "bpmn", revision: 1 }, opId: "z".repeat(33) };
    expect(parseDiagramOperation(oversizeOpId)).toBeNull();
  });
});
