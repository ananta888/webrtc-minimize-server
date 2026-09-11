import assert from "node:assert/strict";
import test from "node:test";
import { recordNativeStatus } from "./helpers/native-status-observation.mjs";

test("native status history retains late failures after renewal floods without mutating prior snapshots", () => {
  const rows = [], prepared = { type: "trusted-source-status", state: "receiver-prepared" };
  recordNativeStatus(rows, prepared); const first = rows[0];
  for (let i = 0; i < 1200; i++) recordNativeStatus(rows, prepared);
  assert.equal(rows.length, 1); assert.equal(rows[0].count, 1000); assert.equal(first.count, 1);
  recordNativeStatus(rows, { type: "assignment-status", state: "failed", reasonCode: "OUTPUT_FAILED" });
  assert.equal(rows.at(-1).code, "OUTPUT_FAILED");
  for (let i = 0; i < 40; i++) recordNativeStatus(rows, { type: "trusted-source-status", state: i % 2 ? "failed" : "stopped" });
  assert.equal(rows.length, 32); assert.equal(rows.at(-1).state, "failed");
  assert.ok(rows.every(Object.isFrozen));
});

test("native status observation projects no source bindings, content or unknown states", () => {
  const rows = [];
  for (const value of [null, {}, { type: "toString", state: "failed" },
    { type: "trusted-source-status", state: "private-canary" }]) recordNativeStatus(rows, value);
  assert.deepEqual(rows, []);
  recordNativeStatus(rows, { type: "trusted-source-status", state: "failed", sourceLeaseId: "private-canary",
    get reasonCode() { throw Error("unused-field"); }, get key() { throw Error("unused-field"); } });
  assert.deepEqual(rows, [{ type: "trusted-source-status", state: "failed", code: null, count: 1 }]);
  assert.doesNotMatch(JSON.stringify(rows), /private-canary/);
});
