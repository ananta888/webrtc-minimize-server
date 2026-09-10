import assert from "node:assert/strict";
import test from "node:test";
import { observeNativeSceneReply, recordNativeSceneReply, assertFreshNativeSceneApply, assertObservedNativeScene, observeNativeSceneSubmission } from "./helpers/native-scene-reply-observation.mjs";

const query = { version: 1, type: "source-program-scene-state", sceneRevision: 1, layout: "waiting-slate",
  availableSources: ["PRIVATE-MARKER"], sourceLeaseIds: [] };
const applied = { version: 1, type: "source-program-scene-applied", sceneRevision: 2 };
const rejected = { version: 1, type: "source-program-scene-rejected", reasonCode: "SCENE_NOT_APPLIED" };

test("HTTP submission observation exposes only layout, version, revision and selection count", () => {
  const input = { action: "apply", requestVersion: 2, expectedSceneRevision: 4, layout: "single", sourceLeaseIds: ["private-source"],
    deviceFingerprint: "private-device", get token() { throw Error("must not inspect token"); } };
  const row = observeNativeSceneSubmission(input);
  assert.deepEqual(row, { version: 2, revision: 4, layout: "single", selected: 1 });
  assert.equal(Object.isFrozen(row), true); assert.doesNotMatch(JSON.stringify(row), /private/);
  for (const value of [null, {}, { action: "query", requestVersion: 2 },
    { action: "apply", requestVersion: 3 }, { ...query, action: "apply" }]) assert.equal(observeNativeSceneSubmission(value), null);
  for (const patch of [{ layout: "private-content" }, { expectedSceneRevision: Infinity }, { sourceLeaseIds: Array(21) }]) {
    assert.equal(observeNativeSceneSubmission({ action: "apply", requestVersion: 2, expectedSceneRevision: 1,
      layout: "single", sourceLeaseIds: [], ...patch }), null);
  }
});

test("post-apply scene must independently confirm the intended layout and source count", () => {
  const receipt = observeNativeSceneReply(applied);
  const state = observeNativeSceneReply({ ...query, sceneRevision: 2, layout: "side-by-side",
    availableSources: ["private-camera", "private-screen"], sourceLeaseIds: ["private-camera", "private-screen"] });
  const expected = { layout: "side-by-side", selected: 2 };
  assertObservedNativeScene([receipt, state], receipt, expected);
  assert.throws(() => assertObservedNativeScene([receipt], receipt, expected), /no new native scene state/);
  for (const [patch, message] of [[{ type: "source-program-scene-applied" }, /observed scene/],
    [{ version: 2 }, /version changed/], [{ revision: 3 }, /revision differs/],
    [{ layout: "waiting-slate" }, /layout differs/], [{ selected: 1 }, /selection count differs/]]) {
    assert.throws(() => assertObservedNativeScene([receipt, { ...state, ...patch }], receipt, expected), message);
  }
  assert.equal(JSON.stringify(state).includes("private-"), false);
});

test("scene receipt projection retains only bounded fixed metadata, not identities or source content", () => {
  const row = observeNativeSceneReply({ ...query, commandId: "PRIVATE-MARKER", leaseId: "PRIVATE-MARKER",
    get media() { throw Error("must not inspect media"); }, get key() { throw Error("must not inspect keys"); } });
  assert.deepEqual(row, { version: 1, type: query.type, revision: 1, layout: "waiting-slate", available: 1, selected: 0, reason: null });
  assert.equal(Object.isFrozen(row), true); assert.equal(JSON.stringify(row).includes("PRIVATE-MARKER"), false);
  for (const value of [null, {}, { ...query, version: 3 }, { ...query, type: "PRIVATE-MARKER" },
    { ...query, sceneRevision: NaN }, { ...query, sceneRevision: 0 }, { ...query, layout: "PRIVATE-MARKER" },
    { ...query, availableSources: Array(21) }, { ...query, sourceLeaseIds: {} },
    { ...rejected, reasonCode: "PRIVATE-MARKER" }, { get version() { throw Error("private"); } }]) {
    assert.equal(observeNativeSceneReply(value), null);
  }
});

test("scene history retains the last eight receipts and ignores unrelated native status messages", () => {
  const rows = [];
  for (let sceneRevision = 1; sceneRevision <= 12; sceneRevision++) recordNativeSceneReply(rows, { ...applied, sceneRevision });
  assert.equal(rows.length, 8); assert.equal(rows[0].revision, 5); assert.equal(rows.at(-1).revision, 12);
  recordNativeSceneReply(rows, { version: 1, type: "trusted-source-status", state: "receiver-prepared" });
  assert.equal(rows.length, 8); assert.equal(rows.at(-1).revision, 12);
});

test("only a new applied revision is a delivery precondition; conflict, expiry and old receipt cannot pass", () => {
  const rows = []; recordNativeSceneReply(rows, query); const previous = rows.at(-1);
  assert.throws(() => assertFreshNativeSceneApply(rows, previous), /no new native receipt/);
  recordNativeSceneReply(rows, rejected);
  assert.throws(() => assertFreshNativeSceneApply(rows, previous), /not an applied receipt/);
  recordNativeSceneReply(rows, { ...applied, sceneRevision: 3 });
  assert.throws(() => assertFreshNativeSceneApply(rows, previous), /queried scene revision/);
  recordNativeSceneReply(rows, applied); assertFreshNativeSceneApply(rows, previous);
  recordNativeSceneReply(rows, { ...applied, version: 2 });
  assert.throws(() => assertFreshNativeSceneApply(rows, previous), /negotiated scene version/);
  recordNativeSceneReply(rows, { ...query, version: 2 }); const v2Previous = rows.at(-1);
  recordNativeSceneReply(rows, { ...applied, version: 2 }); assertFreshNativeSceneApply(rows, v2Previous);
});
