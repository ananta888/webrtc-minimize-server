import assert from "node:assert/strict";
import test from "node:test";

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
