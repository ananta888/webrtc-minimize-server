export type WhiteboardKind = "stroke-begin" | "stroke-point" | "stroke-end" | "erase" | "clear";
export type WhiteboardColor = "ink" | "mark" | "erase";

export interface WhiteboardPoint { readonly x: number; readonly y: number; }
export interface WhiteboardOperation {
  readonly version: 1;
  readonly type: "whiteboard-op";
  readonly opId: string;
  readonly membershipEpoch: number;
  readonly authorPeerId: string;
  readonly kind: WhiteboardKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const KINDS = new Set<WhiteboardKind>(["stroke-begin", "stroke-point", "stroke-end", "erase", "clear"]);
const COLORS = new Set<WhiteboardColor>(["ink", "mark", "erase"]);
const MAX_POINTS = 32;
const MAX_COORD = 10_000;

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === fields.length
    && fields.every((field) => Object.hasOwn(value as object, field));
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function point(value: unknown): WhiteboardPoint | null {
  if (!exact(value, ["x", "y"]) || !integer(value.x, -MAX_COORD, MAX_COORD) || !integer(value.y, -MAX_COORD, MAX_COORD)) {
    return null;
  }
  return { x: value.x as number, y: value.y as number };
}

export function parseWhiteboardOperation(value: unknown): WhiteboardOperation | null {
  if (!exact(value, ["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"])) return null;
  if (value.version !== 1 || value.type !== "whiteboard-op") return null;
  if (typeof value.opId !== "string" || !OP_ID.test(value.opId)) return null;
  if (!integer(value.membershipEpoch, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof value.authorPeerId !== "string" || !PEER_ID.test(value.authorPeerId)) return null;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as WhiteboardKind)) return null;
  const payload = parsePayload(value.kind as WhiteboardKind, value.payload);
  if (!payload) return null;
  return {
    version: 1, type: "whiteboard-op", opId: value.opId, membershipEpoch: value.membershipEpoch as number,
    authorPeerId: value.authorPeerId, kind: value.kind as WhiteboardKind, payload,
  };
}

function parsePayload(kind: WhiteboardKind, payload: unknown): Readonly<Record<string, unknown>> | null {
  if (kind === "clear") return exact(payload, []) ? {} : null;
  if (kind === "stroke-begin") {
    if (!exact(payload, ["color", "width", "point"]) || typeof payload.color !== "string" || !COLORS.has(payload.color as WhiteboardColor)
      || !integer(payload.width, 1, 16)) return null;
    const start = point(payload.point);
    return start ? { color: payload.color, width: payload.width, point: start } : null;
  }
  if (kind === "stroke-point") {
    if (!exact(payload, ["points"]) || !Array.isArray(payload.points)
      || payload.points.length < 1 || payload.points.length > MAX_POINTS) return null;
    const points = payload.points.map(point);
    return points.every(Boolean) ? { points } : null;
  }
  if (kind === "stroke-end" || kind === "erase") {
    if (!exact(payload, ["point"])) return null;
    const end = point(payload.point);
    return end ? { point: end } : null;
  }
  return null;
}

export function decodeWhiteboardBytes(data: Uint8Array): WhiteboardOperation | null {
  try {
    return parseWhiteboardOperation(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodeWhiteboardOperation(operation: WhiteboardOperation): Uint8Array {
  const parsed = parseWhiteboardOperation(operation);
  if (!parsed) throw new Error("invalid_whiteboard_operation");
  return new TextEncoder().encode(JSON.stringify(parsed));
}
