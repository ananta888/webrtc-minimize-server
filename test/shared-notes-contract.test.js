import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_NOTES_CONTRACT,
  SharedNotesContractError,
  parseSharedNotesOperation,
  decodeSharedNotesBytes,
  encodeSharedNotesOperation,
} from "../src/shared-notes-contract.js";

const base = {
  version: 1,
  type: "notes-op",
  opId: "a".repeat(32),
  membershipEpoch: 1,
  authorPeerId: "aaaaaaaaaaaaaaaa",
  kind: "notes-update",
  payload: {
    revision: 1,
    baseRevision: 0,
    text: "Hello, meeting notes!\n- Item 1\n- Item 2\t(note)",
  },
};

test("shared notes operations validate closed schema and bounds", () => {
  const op = parseSharedNotesOperation(base);
  assert.equal(op.kind, "notes-update");
  assert.equal(SHARED_NOTES_CONTRACT.persistence, "ephemeral");
  assert.equal(SHARED_NOTES_CONTRACT.transport, "opaque-overlay-event");
  assert.equal(SHARED_NOTES_CONTRACT.maxTextLength, 32_000);

  // Extra root property fails
  assert.throws(() => parseSharedNotesOperation({ ...base, extra: true }),
    (err) => err instanceof SharedNotesContractError && err.code === "invalid_notes_operation");

  // Unknown kind fails
  assert.throws(() => parseSharedNotesOperation({ ...base, kind: "notes-delete" }),
    /unknown_notes_kind/);

  // Invalid author peer ID
  assert.throws(() => parseSharedNotesOperation({ ...base, authorPeerId: "short" }),
    /invalid_notes_operation/);

  // Invalid epoch
  assert.throws(() => parseSharedNotesOperation({ ...base, membershipEpoch: 0 }),
    /invalid_notes_operation/);
});

test("notes-update accepts valid text with newlines and tabs, rejects null and control chars", () => {
  // Valid text with newlines and tabs
  const valid = parseSharedNotesOperation({
    ...base,
    payload: { revision: 2, baseRevision: 1, text: "# Heading\n\nParagraph\twith\ttab." },
  });
  assert.equal(valid.payload.revision, 2);
  assert.equal(valid.payload.text, "# Heading\n\nParagraph\twith\ttab.");

  // Reject null byte
  assert.throws(() => parseSharedNotesOperation({
    ...base,
    payload: { revision: 1, baseRevision: 0, text: "Text with \x00 null byte" },
  }), /invalid_notes_payload/);

  // Reject ASCII control char (e.g. \x07 bell)
  assert.throws(() => parseSharedNotesOperation({
    ...base,
    payload: { revision: 1, baseRevision: 0, text: "Text with \x07 bell" },
  }), /invalid_notes_payload/);

  // Reject text exceeding 32,000 characters
  assert.throws(() => parseSharedNotesOperation({
    ...base,
    payload: { revision: 1, baseRevision: 0, text: "x".repeat(32_001) },
  }), /invalid_notes_payload/);

  // Text exactly 32,000 characters passes
  const maxText = "x".repeat(32_000);
  const maxOp = parseSharedNotesOperation({
    ...base,
    payload: { revision: 1, baseRevision: 0, text: maxText },
  });
  assert.equal(maxOp.payload.text.length, 32_000);
});

test("notes-sync-request requires empty payload", () => {
  const syncReq = parseSharedNotesOperation({
    ...base,
    kind: "notes-sync-request",
    payload: {},
  });
  assert.equal(syncReq.kind, "notes-sync-request");
  assert.deepEqual(syncReq.payload, {});

  // Non-empty payload fails
  assert.throws(() => parseSharedNotesOperation({
    ...base,
    kind: "notes-sync-request",
    payload: { foo: "bar" },
  }), /invalid_notes_payload/);
});

test("notes-snapshot accepts valid revision and bounded text", () => {
  const snapshot = parseSharedNotesOperation({
    ...base,
    kind: "notes-snapshot",
    payload: { revision: 5, text: "Existing shared notes content" },
  });
  assert.equal(snapshot.kind, "notes-snapshot");
  assert.equal(snapshot.payload.revision, 5);
  assert.equal(snapshot.payload.text, "Existing shared notes content");

  // Negative revision fails
  assert.throws(() => parseSharedNotesOperation({
    ...base,
    kind: "notes-snapshot",
    payload: { revision: -1, text: "test" },
  }), /invalid_notes_payload/);
});

test("encode and decode bytes roundtrip preserves data accurately", () => {
  const op = parseSharedNotesOperation(base);
  const bytes = encodeSharedNotesOperation(op);
  const decoded = decodeSharedNotesBytes(bytes);
  assert.deepEqual(decoded, op);

  // Decoding garbage returns null
  assert.equal(decodeSharedNotesBytes(new Uint8Array([1, 2, 3])), null);
});
