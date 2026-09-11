export type PollKind =
  | "poll-create"
  | "poll-vote"
  | "poll-publish"
  | "poll-close"
  | "poll-sync-request"
  | "poll-snapshot";

export interface PollDefinition {
  readonly pollId: string;
  readonly creatorPeerId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly anonymous: boolean;
}

export interface PollCreatePayload {
  readonly pollId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly anonymous: boolean;
}

export interface PollVotePayload {
  readonly pollId: string;
  readonly optionIndex: number;
}

export interface PollPublishPayload {
  readonly pollId: string;
  readonly counts: readonly number[];
  readonly totalVotes: number;
}

export interface PollClosePayload {
  readonly pollId: string;
  readonly counts: readonly number[];
  readonly totalVotes: number;
}

export interface PollSnapshotPayload {
  readonly status: "none" | "active" | "published" | "closed";
  readonly poll: PollDefinition | null;
  readonly counts: readonly number[];
  readonly totalVotes: number;
}

export type PollPayload =
  | PollCreatePayload
  | PollVotePayload
  | PollPublishPayload
  | PollClosePayload
  | PollSnapshotPayload
  | Readonly<Record<string, never>>;

export interface PollOperation {
  readonly version: 1;
  readonly type: "poll-op";
  readonly opId: string;
  readonly membershipEpoch: number;
  readonly authorPeerId: string;
  readonly kind: PollKind;
  readonly payload: PollPayload;
}

const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const POLL_ID = /^[a-f0-9]{32}$/;
const KINDS = new Set<PollKind>([
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

export const POLL_CONSTANTS = Object.freeze({
  maxQuestionLength: MAX_QUESTION_LENGTH,
  minOptions: MIN_OPTIONS,
  maxOptions: MAX_OPTIONS,
  maxOptionLength: MAX_OPTION_LENGTH,
  trafficClass: "event" as const,
  persistence: "ephemeral" as const,
});

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === fields.length
    && fields.every((field) => Object.hasOwn(value as object, field));
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength && !DISALLOWED_CONTROL_CHARS.test(trimmed);
}

export function parsePollOperation(value: unknown): PollOperation | null {
  if (!exact(value, ["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"])) {
    return null;
  }
  if (value["version"] !== 1 || value["type"] !== "poll-op") return null;
  if (typeof value["opId"] !== "string" || !OP_ID.test(value["opId"])) return null;
  if (!integer(value["membershipEpoch"], 1, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof value["authorPeerId"] !== "string" || !PEER_ID.test(value["authorPeerId"])) return null;
  if (typeof value["kind"] !== "string" || !KINDS.has(value["kind"] as PollKind)) return null;

  const kind = value["kind"] as PollKind;
  const rawPayload = value["payload"];

  if (kind === "poll-sync-request") {
    if (!exact(rawPayload, [])) return null;
    return {
      version: 1,
      type: "poll-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {},
    };
  }

  if (kind === "poll-create") {
    if (!exact(rawPayload, ["pollId", "question", "options", "anonymous"])) return null;
    if (typeof rawPayload["pollId"] !== "string" || !POLL_ID.test(rawPayload["pollId"])) return null;
    if (typeof rawPayload["anonymous"] !== "boolean") return null;
    if (!validText(rawPayload["question"], MAX_QUESTION_LENGTH)) return null;
    if (!Array.isArray(rawPayload["options"]) || rawPayload["options"].length < MIN_OPTIONS || rawPayload["options"].length > MAX_OPTIONS) {
      return null;
    }
    const options: string[] = [];
    for (const opt of rawPayload["options"]) {
      if (!validText(opt, MAX_OPTION_LENGTH)) return null;
      options.push(opt.trim());
    }
    return {
      version: 1,
      type: "poll-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {
        pollId: rawPayload["pollId"],
        question: (rawPayload["question"] as string).trim(),
        options: Object.freeze(options),
        anonymous: rawPayload["anonymous"],
      },
    };
  }

  if (kind === "poll-vote") {
    if (!exact(rawPayload, ["pollId", "optionIndex"])) return null;
    if (typeof rawPayload["pollId"] !== "string" || !POLL_ID.test(rawPayload["pollId"])) return null;
    if (!integer(rawPayload["optionIndex"], 0, MAX_OPTIONS - 1)) return null;
    return {
      version: 1,
      type: "poll-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {
        pollId: rawPayload["pollId"],
        optionIndex: rawPayload["optionIndex"] as number,
      },
    };
  }

  if (kind === "poll-publish" || kind === "poll-close") {
    if (!exact(rawPayload, ["pollId", "counts", "totalVotes"])) return null;
    if (typeof rawPayload["pollId"] !== "string" || !POLL_ID.test(rawPayload["pollId"])) return null;
    if (!Array.isArray(rawPayload["counts"]) || rawPayload["counts"].length < MIN_OPTIONS || rawPayload["counts"].length > MAX_OPTIONS) {
      return null;
    }
    for (const cnt of rawPayload["counts"]) {
      if (!integer(cnt, 0, 1000)) return null;
    }
    if (!integer(rawPayload["totalVotes"], 0, 1000)) return null;
    return {
      version: 1,
      type: "poll-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {
        pollId: rawPayload["pollId"],
        counts: Object.freeze([...rawPayload["counts"] as number[]]),
        totalVotes: rawPayload["totalVotes"] as number,
      },
    };
  }

  if (kind === "poll-snapshot") {
    if (!exact(rawPayload, ["status", "poll", "counts", "totalVotes"])) return null;
    const validStatuses = ["none", "active", "published", "closed"];
    if (typeof rawPayload["status"] !== "string" || !validStatuses.includes(rawPayload["status"])) return null;
    let poll: PollDefinition | null = null;
    if (rawPayload["poll"] !== null) {
      const p = rawPayload["poll"];
      if (!exact(p, ["pollId", "creatorPeerId", "question", "options", "anonymous"])) return null;
      if (typeof p["pollId"] !== "string" || !POLL_ID.test(p["pollId"])) return null;
      if (typeof p["creatorPeerId"] !== "string" || !PEER_ID.test(p["creatorPeerId"])) return null;
      if (typeof p["anonymous"] !== "boolean") return null;
      if (!validText(p["question"], MAX_QUESTION_LENGTH)) return null;
      if (!Array.isArray(p["options"]) || p["options"].length < MIN_OPTIONS || p["options"].length > MAX_OPTIONS) return null;
      const opts: string[] = [];
      for (const opt of p["options"]) {
        if (!validText(opt, MAX_OPTION_LENGTH)) return null;
        opts.push(opt.trim());
      }
      poll = Object.freeze({
        pollId: p["pollId"],
        creatorPeerId: p["creatorPeerId"],
        question: (p["question"] as string).trim(),
        options: Object.freeze(opts),
        anonymous: p["anonymous"],
      });
    }
    if (!Array.isArray(rawPayload["counts"])) return null;
    for (const cnt of rawPayload["counts"]) {
      if (!integer(cnt, 0, 1000)) return null;
    }
    if (!integer(rawPayload["totalVotes"], 0, 1000)) return null;
    return {
      version: 1,
      type: "poll-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {
        status: rawPayload["status"] as "none" | "active" | "published" | "closed",
        poll,
        counts: Object.freeze([...rawPayload["counts"] as number[]]),
        totalVotes: rawPayload["totalVotes"] as number,
      },
    };
  }

  return null;
}

export function decodePollBytes(data: Uint8Array): PollOperation | null {
  try {
    return parsePollOperation(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodePollOperation(operation: PollOperation): Uint8Array {
  const parsed = parsePollOperation(operation);
  if (!parsed) throw new Error("invalid_poll_operation");
  return new TextEncoder().encode(JSON.stringify(parsed));
}
