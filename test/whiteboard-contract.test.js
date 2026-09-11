import assert from "node:assert/strict";
import test from "node:test";

import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { WHITEBOARD_CONTRACT, WhiteboardContractError, parseWhiteboardOperation } from "../src/whiteboard-contract.js";

const base = {
  version: 1, type: "whiteboard-op", opId: "a".repeat(32), membershipEpoch: 2,
  authorPeerId: "aaaaaaaaaaaaaaaa", kind: "stroke-begin",
  payload: { color: "ink", width: 2, point: { x: 1, y: -2 } },
};

test("whiteboard operations are closed, bounded and never HTML", () => {
  const op = parseWhiteboardOperation(base);
  assert.equal(op.kind, "stroke-begin");
  assert.equal(WHITEBOARD_CONTRACT.persistence, "ephemeral");
  assert.equal(WHITEBOARD_CONTRACT.transport, "opaque-overlay-event");
  assert.throws(() => parseWhiteboardOperation({ ...base, extra: true }),
    (error) => error instanceof WhiteboardContractError);
  assert.throws(() => parseWhiteboardOperation({ ...base, kind: "script" }), /unknown_whiteboard_kind/);
  assert.throws(() => parseWhiteboardOperation({
    ...base, kind: "stroke-point", payload: { points: [{ x: 1, y: 1, html: "<img>" }] },
  }), /invalid_whiteboard_point/);
  const many = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  assert.throws(() => parseWhiteboardOperation({
    ...base, kind: "stroke-point", payload: { points: many },
  }), /invalid_whiteboard_payload/);
  assert.deepEqual(parseWhiteboardOperation({
    ...base, kind: "clear", payload: {},
  }).payload, {});
});

test("whiteboard shapes and text are bounded and fail-closed", () => {
  const shapeOp = parseWhiteboardOperation({
    ...base,
    kind: "shape",
    payload: { shape: "rectangle", color: "accent", width: 3, start: { x: 10, y: 20 }, end: { x: 100, y: 200 } },
  });
  assert.equal(shapeOp.kind, "shape");
  assert.equal(shapeOp.payload.shape, "rectangle");

  const ellipseOp = parseWhiteboardOperation({
    ...base,
    kind: "shape",
    payload: { shape: "ellipse", color: "ink", width: 2, start: { x: 0, y: 0 }, end: { x: 50, y: 50 } },
  });
  assert.equal(ellipseOp.payload.shape, "ellipse");

  const lineOp = parseWhiteboardOperation({
    ...base,
    kind: "shape",
    payload: { shape: "line", color: "mark", width: 4, start: { x: 5, y: 5 }, end: { x: 80, y: 90 } },
  });
  assert.equal(lineOp.payload.shape, "line");

  // Invalid shape type
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "shape",
    payload: { shape: "triangle", color: "ink", width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
  }), /invalid_whiteboard_payload/);

  // Erase color not allowed for shape
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "shape",
    payload: { shape: "rectangle", color: "erase", width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
  }), /invalid_whiteboard_payload/);

  // Text operation
  const textOp = parseWhiteboardOperation({
    ...base,
    kind: "text",
    payload: { text: "Hello WebRTC", point: { x: 50, y: 100 }, color: "accent", size: 16 },
  });
  assert.equal(textOp.kind, "text");
  assert.equal(textOp.payload.text, "Hello WebRTC");

  // Control characters rejected
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "text",
    payload: { text: "Hello\x00World", point: { x: 0, y: 0 }, color: "ink", size: 16 },
  }), /invalid_whiteboard_payload/);

  // Empty or whitespace-only text rejected
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "text",
    payload: { text: "   ", point: { x: 0, y: 0 }, color: "ink", size: 16 },
  }), /invalid_whiteboard_payload/);

  // Text too long (> 100 chars)
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "text",
    payload: { text: "a".repeat(101), point: { x: 0, y: 0 }, color: "ink", size: 16 },
  }), /invalid_whiteboard_payload/);

  // Text size out of bounds (10-48)
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "text",
    payload: { text: "Hi", point: { x: 0, y: 0 }, color: "ink", size: 5 },
  }), /invalid_whiteboard_payload/);
});

test("whiteboard sync-request and sync-response are strictly validated", () => {
  const req = parseWhiteboardOperation({
    ...base,
    kind: "sync-request",
    payload: {},
  });
  assert.equal(req.kind, "sync-request");
  assert.deepEqual(req.payload, {});

  const strokeOp = parseWhiteboardOperation(base);
  const resp = parseWhiteboardOperation({
    ...base,
    kind: "sync-response",
    payload: { ops: [strokeOp] },
  });
  assert.equal(resp.kind, "sync-response");
  assert.equal(resp.payload.ops.length, 1);

  // Nested sync-response or sync-request inside sync-response is forbidden
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "sync-response",
    payload: { ops: [req] },
  }), /invalid_whiteboard_payload/);

  // Exceeding MAX_SYNC_OPS (64)
  const tooMany = Array.from({ length: 65 }, () => strokeOp);
  assert.throws(() => parseWhiteboardOperation({
    ...base,
    kind: "sync-response",
    payload: { ops: tooMany },
  }), /invalid_whiteboard_payload/);
});

test("whiteboard clear signaling is closed and content-free", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "whiteboard-clear" })), { type: "whiteboard-clear" });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "whiteboard-clear", extra: true })),
    (error) => error instanceof ProtocolError && error.code === "unknown_message_field");
});

