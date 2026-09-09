import assert from "node:assert/strict";
import test from "node:test";
import { avatarFailureSnapshot } from "./helpers/machine-avatar-failure.mjs";

test("avatar failure diagnostics retain only fixed synthetic observations", () => {
  const value = avatarFailureSnapshot("hold", { sample: { center: [20, 20, 220, 255], white: 240, bright: 40, decodedWidth: 128 },
    videos: [{ width: 128, height: 128, ready: 4, attached: true, src: "private" }],
    captureCalls: 0, transformErrors: 0, secret: "private" }, { state: "open", generation: 3, frames: 17, sourceId: "private" });
  assert.deepEqual(value.sample, { center: [20, 20, 220, 255], white: 240, bright: 40, decodedWidth: 128 });
  assert.deepEqual(value.source, { state: "open", generation: 3, frames: 17 });
  assert.equal(value.phase, "hold"); assert.ok(!JSON.stringify(value).includes("private"));
});

test("avatar failure diagnostics bound malformed fields and rows", () => {
  const value = avatarFailureSnapshot("private", { sample: { center: [1, 2, 3, 256], white: -1, bright: 999, decodedWidth: "private" },
    videos: Array.from({ length: 200 }, () => ({ width: Infinity, height: "private", ready: 9, attached: "private" })),
    captureCalls: -1, transformErrors: 999 }, { state: "private", generation: NaN, frames: 1e20 });
  assert.equal(value.phase, "unknown"); assert.equal(value.videos.length, 8);
  assert.deepEqual(value.sample, { center: null, white: null, bright: null, decodedWidth: null });
  assert.deepEqual(value.source, { state: "unknown", generation: null, frames: null });
  assert.equal(value.captureCalls, null); assert.equal(value.transformErrors, null);
  assert.ok(!JSON.stringify(value).includes("private"));
  assert.doesNotThrow(() => avatarFailureSnapshot(null, null, null));
});
