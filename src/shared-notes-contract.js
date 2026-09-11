const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const KINDS = Object.freeze(["notes-update", "notes-sync-request", "notes-snapshot"]);
const MAX_NOTES_TEXT_LENGTH = 32_000;
const DISALLOWED_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class SharedNotesContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "SharedNotesContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new SharedNotesContractError(code);
}

function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function exact(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function validateNotesText(text, code = "invalid_notes_payload") {
  if (typeof text !== "string") fail(code);
  if (text.length > MAX_NOTES_TEXT_LENGTH) fail(code);
  if (DISALLOWED_CONTROL_CHARS.test(text)) fail(code);
  return text;
}

export function parseSharedNotesOperation(value) {
  exact(value, new Set(["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"]),
    "invalid_notes_operation");
  if (value.version !== 1 || value.type !== "notes-op") fail("invalid_notes_operation");
  if (typeof value.opId !== "string" || !OP_ID.test(value.opId)) fail("invalid_notes_operation");
  integer(value.membershipEpoch, 1, Number.MAX_SAFE_INTEGER, "invalid_notes_operation");
  if (typeof value.authorPeerId !== "string" || !PEER_ID.test(value.authorPeerId)) fail("invalid_notes_operation");
  if (!KINDS.includes(value.kind)) fail("unknown_notes_kind");
  const payload = parsePayload(value.kind, value.payload);
  return Object.freeze({
    version: 1,
    type: "notes-op",
    opId: value.opId,
    membershipEpoch: value.membershipEpoch,
    authorPeerId: value.authorPeerId,
    kind: value.kind,
    payload,
  });
}

function parsePayload(kind, payload) {
  if (kind === "notes-sync-request") {
    exact(payload, new Set([]), "invalid_notes_payload");
    return Object.freeze({});
  }
  if (kind === "notes-update") {
    exact(payload, new Set(["revision", "baseRevision", "text"]), "invalid_notes_payload");
    return Object.freeze({
      revision: integer(payload.revision, 1, Number.MAX_SAFE_INTEGER, "invalid_notes_payload"),
      baseRevision: integer(payload.baseRevision, 0, Number.MAX_SAFE_INTEGER, "invalid_notes_payload"),
      text: validateNotesText(payload.text),
    });
  }
  if (kind === "notes-snapshot") {
    exact(payload, new Set(["revision", "text"]), "invalid_notes_payload");
    return Object.freeze({
      revision: integer(payload.revision, 0, Number.MAX_SAFE_INTEGER, "invalid_notes_payload"),
      text: validateNotesText(payload.text),
    });
  }
  fail("unknown_notes_kind");
}

export function decodeSharedNotesBytes(data) {
  try {
    return parseSharedNotesOperation(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodeSharedNotesOperation(operation) {
  const parsed = parseSharedNotesOperation(operation);
  return new TextEncoder().encode(JSON.stringify(parsed));
}

export const SHARED_NOTES_CONTRACT = Object.freeze({
  version: 1,
  kinds: KINDS,
  maxTextLength: MAX_NOTES_TEXT_LENGTH,
  transport: "opaque-overlay-event",
  persistence: "ephemeral",
});
