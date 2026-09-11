const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const KINDS = Object.freeze(["stroke-begin", "stroke-point", "stroke-end", "erase", "clear"]);
const COLORS = Object.freeze(["ink", "mark", "erase"]);
const MAX_POINTS = 32;
const MAX_COORD = 10_000;

export class WhiteboardContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "WhiteboardContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new WhiteboardContractError(code);
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

function point(value) {
  exact(value, new Set(["x", "y"]), "invalid_whiteboard_point");
  return Object.freeze({
    x: integer(value.x, -MAX_COORD, MAX_COORD, "invalid_whiteboard_point"),
    y: integer(value.y, -MAX_COORD, MAX_COORD, "invalid_whiteboard_point"),
  });
}

export function parseWhiteboardOperation(value) {
  exact(value, new Set(["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"]),
    "invalid_whiteboard_operation");
  if (value.version !== 1 || value.type !== "whiteboard-op") fail("invalid_whiteboard_operation");
  if (typeof value.opId !== "string" || !OP_ID.test(value.opId)) fail("invalid_whiteboard_operation");
  integer(value.membershipEpoch, 1, Number.MAX_SAFE_INTEGER, "invalid_whiteboard_operation");
  if (typeof value.authorPeerId !== "string" || !PEER_ID.test(value.authorPeerId)) fail("invalid_whiteboard_operation");
  if (!KINDS.includes(value.kind)) fail("unknown_whiteboard_kind");
  const payload = parsePayload(value.kind, value.payload);
  return Object.freeze({
    version: 1,
    type: "whiteboard-op",
    opId: value.opId,
    membershipEpoch: value.membershipEpoch,
    authorPeerId: value.authorPeerId,
    kind: value.kind,
    payload,
  });
}

function parsePayload(kind, payload) {
  if (kind === "clear") {
    exact(payload, new Set([]), "invalid_whiteboard_payload");
    return Object.freeze({});
  }
  if (kind === "stroke-begin") {
    exact(payload, new Set(["color", "width", "point"]), "invalid_whiteboard_payload");
    if (!COLORS.includes(payload.color)) fail("invalid_whiteboard_payload");
    return Object.freeze({
      color: payload.color,
      width: integer(payload.width, 1, 16, "invalid_whiteboard_payload"),
      point: point(payload.point),
    });
  }
  if (kind === "stroke-point") {
    exact(payload, new Set(["points"]), "invalid_whiteboard_payload");
    if (!Array.isArray(payload.points) || payload.points.length < 1 || payload.points.length > MAX_POINTS) {
      fail("invalid_whiteboard_payload");
    }
    return Object.freeze({ points: Object.freeze(payload.points.map(point)) });
  }
  if (kind === "stroke-end" || kind === "erase") {
    exact(payload, new Set(["point"]), "invalid_whiteboard_payload");
    return Object.freeze({ point: point(payload.point) });
  }
  fail("unknown_whiteboard_kind");
}

export const WHITEBOARD_CONTRACT = Object.freeze({
  version: 1,
  kinds: KINDS,
  colors: COLORS,
  maxPoints: MAX_POINTS,
  maxCoord: MAX_COORD,
  transport: "opaque-overlay-event",
  persistence: "ephemeral",
});
