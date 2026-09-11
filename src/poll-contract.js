const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const POLL_ID = /^[a-f0-9]{32}$/;
const KINDS = Object.freeze([
  "poll-create",
  "poll-vote",
  "poll-publish",
  "poll-close",
  "poll-sync-request",
  "poll-snapshot",
]);
const MAX_QUESTION_LENGTH = 120;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_OPTION_LENGTH = 60;
const DISALLOWED_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export class PollContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "PollContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new PollContractError(code);
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

function validateText(text, maxLength, code = "invalid_poll_payload") {
  if (typeof text !== "string") fail(code);
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maxLength) fail(code);
  if (DISALLOWED_CONTROL_CHARS.test(trimmed)) fail(code);
  return trimmed;
}

export function parsePollOperation(value) {
  exact(value, new Set(["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"]),
    "invalid_poll_operation");
  if (value.version !== 1 || value.type !== "poll-op") fail("invalid_poll_operation");
  if (typeof value.opId !== "string" || !OP_ID.test(value.opId)) fail("invalid_poll_operation");
  integer(value.membershipEpoch, 1, Number.MAX_SAFE_INTEGER, "invalid_poll_operation");
  if (typeof value.authorPeerId !== "string" || !PEER_ID.test(value.authorPeerId)) fail("invalid_poll_operation");
  if (!KINDS.includes(value.kind)) fail("unknown_poll_kind");

  const payload = parsePayload(value.kind, value.payload);
  return Object.freeze({
    version: 1,
    type: "poll-op",
    opId: value.opId,
    membershipEpoch: value.membershipEpoch,
    authorPeerId: value.authorPeerId,
    kind: value.kind,
    payload,
  });
}

function parsePayload(kind, payload) {
  if (kind === "poll-sync-request") {
    exact(payload, new Set([]), "invalid_poll_payload");
    return Object.freeze({});
  }

  if (kind === "poll-create") {
    exact(payload, new Set(["pollId", "question", "options", "anonymous"]), "invalid_poll_payload");
    if (typeof payload.pollId !== "string" || !POLL_ID.test(payload.pollId)) fail("invalid_poll_payload");
    if (typeof payload.anonymous !== "boolean") fail("invalid_poll_payload");
    const question = validateText(payload.question, MAX_QUESTION_LENGTH);
    if (!Array.isArray(payload.options) || payload.options.length < MIN_OPTIONS || payload.options.length > MAX_OPTIONS) {
      fail("invalid_poll_payload");
    }
    const options = Object.freeze(payload.options.map((opt) => validateText(opt, MAX_OPTION_LENGTH)));
    return Object.freeze({
      pollId: payload.pollId,
      question,
      options,
      anonymous: payload.anonymous,
    });
  }

  if (kind === "poll-vote") {
    exact(payload, new Set(["pollId", "optionIndex"]), "invalid_poll_payload");
    if (typeof payload.pollId !== "string" || !POLL_ID.test(payload.pollId)) fail("invalid_poll_payload");
    return Object.freeze({
      pollId: payload.pollId,
      optionIndex: integer(payload.optionIndex, 0, MAX_OPTIONS - 1, "invalid_poll_payload"),
    });
  }

  if (kind === "poll-publish" || kind === "poll-close") {
    exact(payload, new Set(["pollId", "counts", "totalVotes"]), "invalid_poll_payload");
    if (typeof payload.pollId !== "string" || !POLL_ID.test(payload.pollId)) fail("invalid_poll_payload");
    if (!Array.isArray(payload.counts) || payload.counts.length < MIN_OPTIONS || payload.counts.length > MAX_OPTIONS) {
      fail("invalid_poll_payload");
    }
    const counts = Object.freeze(payload.counts.map((cnt) => integer(cnt, 0, 1000, "invalid_poll_payload")));
    return Object.freeze({
      pollId: payload.pollId,
      counts,
      totalVotes: integer(payload.totalVotes, 0, 1000, "invalid_poll_payload"),
    });
  }

  if (kind === "poll-snapshot") {
    exact(payload, new Set(["status", "poll", "counts", "totalVotes"]), "invalid_poll_payload");
    const validStatuses = ["none", "active", "published", "closed"];
    if (typeof payload.status !== "string" || !validStatuses.includes(payload.status)) fail("invalid_poll_payload");
    let poll = null;
    if (payload.poll !== null) {
      exact(payload.poll, new Set(["pollId", "question", "options", "anonymous", "creatorPeerId"]), "invalid_poll_payload");
      if (typeof payload.poll.pollId !== "string" || !POLL_ID.test(payload.poll.pollId)) fail("invalid_poll_payload");
      if (typeof payload.poll.creatorPeerId !== "string" || !PEER_ID.test(payload.poll.creatorPeerId)) fail("invalid_poll_payload");
      if (typeof payload.poll.anonymous !== "boolean") fail("invalid_poll_payload");
      const question = validateText(payload.poll.question, MAX_QUESTION_LENGTH);
      if (!Array.isArray(payload.poll.options) || payload.poll.options.length < MIN_OPTIONS || payload.poll.options.length > MAX_OPTIONS) {
        fail("invalid_poll_payload");
      }
      const options = Object.freeze(payload.poll.options.map((opt) => validateText(opt, MAX_OPTION_LENGTH)));
      poll = Object.freeze({
        pollId: payload.poll.pollId,
        creatorPeerId: payload.poll.creatorPeerId,
        question,
        options,
        anonymous: payload.poll.anonymous,
      });
    }
    if (!Array.isArray(payload.counts)) fail("invalid_poll_payload");
    const counts = Object.freeze(payload.counts.map((cnt) => integer(cnt, 0, 1000, "invalid_poll_payload")));
    return Object.freeze({
      status: payload.status,
      poll,
      counts,
      totalVotes: integer(payload.totalVotes, 0, 1000, "invalid_poll_payload"),
    });
  }

  fail("unknown_poll_kind");
}

export function decodePollBytes(data) {
  try {
    return parsePollOperation(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodePollOperation(operation) {
  const parsed = parsePollOperation(operation);
  return new TextEncoder().encode(JSON.stringify(parsed));
}

export const POLL_CONTRACT = Object.freeze({
  version: 1,
  kinds: KINDS,
  maxQuestionLength: MAX_QUESTION_LENGTH,
  minOptions: MIN_OPTIONS,
  maxOptions: MAX_OPTIONS,
  maxOptionLength: MAX_OPTION_LENGTH,
  transport: "opaque-overlay-event",
  persistence: "ephemeral",
});
