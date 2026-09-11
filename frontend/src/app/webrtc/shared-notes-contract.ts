export type SharedNotesKind = "notes-update" | "notes-sync-request" | "notes-snapshot";

export interface SharedNotesUpdatePayload {
  readonly revision: number;
  readonly baseRevision: number;
  readonly text: string;
}

export interface SharedNotesSnapshotPayload {
  readonly revision: number;
  readonly text: string;
}

export type SharedNotesPayload =
  | SharedNotesUpdatePayload
  | SharedNotesSnapshotPayload
  | Readonly<Record<string, never>>;

export interface SharedNotesOperation {
  readonly version: 1;
  readonly type: "notes-op";
  readonly opId: string;
  readonly membershipEpoch: number;
  readonly authorPeerId: string;
  readonly kind: SharedNotesKind;
  readonly payload: SharedNotesPayload;
}

const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const KINDS = new Set<SharedNotesKind>(["notes-update", "notes-sync-request", "notes-snapshot"]);
const DISALLOWED_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export const MAX_NOTES_TEXT_LENGTH = 32_000;

export const SHARED_NOTES_CONSTANTS = Object.freeze({
  maxTextLength: MAX_NOTES_TEXT_LENGTH,
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

function validText(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_NOTES_TEXT_LENGTH
    && !DISALLOWED_CONTROL_CHARS.test(value);
}

export function parseSharedNotesOperation(value: unknown): SharedNotesOperation | null {
  if (!exact(value, ["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"])) {
    return null;
  }
  if (value["version"] !== 1 || value["type"] !== "notes-op") return null;
  if (typeof value["opId"] !== "string" || !OP_ID.test(value["opId"])) return null;
  if (!integer(value["membershipEpoch"], 1, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof value["authorPeerId"] !== "string" || !PEER_ID.test(value["authorPeerId"])) return null;
  if (typeof value["kind"] !== "string" || !KINDS.has(value["kind"] as SharedNotesKind)) return null;

  const kind = value["kind"] as SharedNotesKind;
  const rawPayload = value["payload"];

  if (kind === "notes-sync-request") {
    if (!exact(rawPayload, [])) return null;
    return {
      version: 1,
      type: "notes-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {},
    };
  }

  if (kind === "notes-update") {
    if (!exact(rawPayload, ["revision", "baseRevision", "text"])) return null;
    if (!integer(rawPayload["revision"], 1, Number.MAX_SAFE_INTEGER)) return null;
    if (!integer(rawPayload["baseRevision"], 0, Number.MAX_SAFE_INTEGER)) return null;
    if (!validText(rawPayload["text"])) return null;
    return {
      version: 1,
      type: "notes-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {
        revision: rawPayload["revision"] as number,
        baseRevision: rawPayload["baseRevision"] as number,
        text: rawPayload["text"] as string,
      },
    };
  }

  if (kind === "notes-snapshot") {
    if (!exact(rawPayload, ["revision", "text"])) return null;
    if (!integer(rawPayload["revision"], 0, Number.MAX_SAFE_INTEGER)) return null;
    if (!validText(rawPayload["text"])) return null;
    return {
      version: 1,
      type: "notes-op",
      opId: value["opId"],
      membershipEpoch: value["membershipEpoch"] as number,
      authorPeerId: value["authorPeerId"],
      kind,
      payload: {
        revision: rawPayload["revision"] as number,
        text: rawPayload["text"] as string,
      },
    };
  }

  return null;
}

export function decodeSharedNotesBytes(data: Uint8Array): SharedNotesOperation | null {
  try {
    return parseSharedNotesOperation(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodeSharedNotesOperation(operation: SharedNotesOperation): Uint8Array {
  const parsed = parseSharedNotesOperation(operation);
  if (!parsed) throw new Error("invalid_notes_operation");
  return new TextEncoder().encode(JSON.stringify(parsed));
}
