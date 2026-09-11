import { describe, expect, it } from "vitest";

import {
  MAX_NOTES_TEXT_LENGTH,
  SHARED_NOTES_CONSTANTS,
  decodeSharedNotesBytes,
  encodeSharedNotesOperation,
  parseSharedNotesOperation,
  SharedNotesOperation,
} from "./shared-notes-contract";

describe("shared-notes-contract (frontend)", () => {
  const baseOp: SharedNotesOperation = {
    version: 1,
    type: "notes-op",
    opId: "b".repeat(32),
    membershipEpoch: 2,
    authorPeerId: "1234567890abcdef",
    kind: "notes-update",
    payload: {
      revision: 3,
      baseRevision: 2,
      text: "# Meeting Agenda\n- Discuss architecture\n- Review PRs",
    },
  };

  it("parses valid operations correctly", () => {
    const parsed = parseSharedNotesOperation(baseOp);
    expect(parsed).toEqual(baseOp);
    expect(SHARED_NOTES_CONSTANTS.maxTextLength).toBe(MAX_NOTES_TEXT_LENGTH);
    expect(SHARED_NOTES_CONSTANTS.trafficClass).toBe("event");
  });

  it("fails closed on invalid kinds or missing fields", () => {
    expect(parseSharedNotesOperation({ ...baseOp, kind: "unknown" })).toBeNull();
    expect(parseSharedNotesOperation({ ...baseOp, version: 2 })).toBeNull();
    expect(parseSharedNotesOperation({ ...baseOp, authorPeerId: "invalid" })).toBeNull();
    expect(parseSharedNotesOperation({ ...baseOp, extra: "not allowed" })).toBeNull();
  });

  it("rejects text exceeding 32,000 characters and disallowed control characters", () => {
    expect(parseSharedNotesOperation({
      ...baseOp,
      payload: { revision: 1, baseRevision: 0, text: "x".repeat(32_001) },
    })).toBeNull();

    expect(parseSharedNotesOperation({
      ...baseOp,
      payload: { revision: 1, baseRevision: 0, text: "Bad\x00character" },
    })).toBeNull();

    expect(parseSharedNotesOperation({
      ...baseOp,
      payload: { revision: 1, baseRevision: 0, text: "Bell\x07char" },
    })).toBeNull();
  });

  it("parses notes-sync-request and notes-snapshot", () => {
    const syncReq = parseSharedNotesOperation({
      ...baseOp,
      kind: "notes-sync-request",
      payload: {},
    });
    expect(syncReq).not.toBeNull();
    expect(syncReq?.kind).toBe("notes-sync-request");

    const snapshot = parseSharedNotesOperation({
      ...baseOp,
      kind: "notes-snapshot",
      payload: { revision: 10, text: "Full notes snapshot" },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.kind).toBe("notes-snapshot");
  });

  it("encodes and decodes bytes accurately", () => {
    const bytes = encodeSharedNotesOperation(baseOp);
    const decoded = decodeSharedNotesBytes(bytes);
    expect(decoded).toEqual(baseOp);

    expect(decodeSharedNotesBytes(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});
