import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { normalizeNativeSourceSceneQuery, normalizeNativeSourceSceneState, normalizeNativeSourceSceneRejection } from "../src/native-source-scene-query.js";

const fixture = name => JSON.parse(readFileSync(new URL(`../native-broadcast-packager/testdata/source-scene${name}.v1.json`, import.meta.url)));
const schema = name => new Ajv({ strict: true }).compile(JSON.parse(readFileSync(new URL(`../contracts/native-packager/source-scene-${name}.v1.schema.json`, import.meta.url))));
const query = fixture("-query"), state = fixture("-state"), rejected = fixture("-rejected"), command = fixture("");
const now = query.issuedAt;

test("query/state/rejection share native fixtures and closed schemas", () => {
  for (const [name, value, normalize] of [
    ["query", query, value => normalizeNativeSourceSceneQuery(value, now)],
    ["state", state, value => normalizeNativeSourceSceneState(value, query, now)],
    ["rejected", rejected, value => normalizeNativeSourceSceneRejection(value, command, now)],
  ]) {
    const valid = schema(name), result = normalize(value);
    assert.equal(valid(value), true, JSON.stringify(valid.errors));
    assert.deepEqual(result, value); assert.equal(Object.isFrozen(result), true);
    assert.equal(valid({ ...value, authority: true }), false);
    assert.throws(() => normalize({ ...value, authority: true }));
    for (const key of Object.keys(value)) {
      assert.throws(() => normalize({ ...value, [key]: null }));
      const missing = { ...value }; delete missing[key]; assert.throws(() => normalize(missing));
    }
  }
});

test("query shares exact reference and deadline bounds without mutating a scene", () => {
  for (const change of [{ version: 3 }, { type: "source-program-scene" }, { commandId: "scn_short" },
    { programEpoch: 0 }, { fencingRevision: Number.MAX_SAFE_INTEGER + 1 }, { expiresAt: now },
    { expiresAt: now + 4001 }, { issuedAt: now + 1001 }, { expectedSceneRevision: 1 }])
    assert.throws(() => normalizeNativeSourceSceneQuery({ ...query, ...change }, now));
  assert.throws(() => normalizeNativeSourceSceneQuery(query, query.expiresAt));
  assert.throws(() => normalizeNativeSourceSceneQuery(query, NaN));
});

test("state binds every scope field and observation time to the still-current query", () => {
  for (const change of [{ commandId: "scn_bbbbbbbbbbbbbbbb" }, { assignmentId: "asn_bbbbbbbbbbbbbbbb" },
    { programId: "prg_bbbbbbbbbbbbbbbb" }, { programEpoch: 2 }, { leaseId: "lea_bbbbbbbbbbbbbbbb" },
    { fencingRevision: 2 }, { observedAt: now - 1001 }, { observedAt: now + 1001 },
    { observedAt: query.expiresAt }, { sceneRevision: 0 }, { sceneRevision: 1.5 },
    { sceneRevision: Number.MAX_SAFE_INTEGER + 1 }])
    assert.throws(() => normalizeNativeSourceSceneState({ ...state, ...change }, query, now));
  assert.throws(() => normalizeNativeSourceSceneState(state, query, query.expiresAt));
});

test("state distinguishes configured selection from currently available inputs and owns its metadata", () => {
  const id = "sls_aaaaaaaaaaaaaaaa", available = { sourceLeaseId: id, sourceKind: "camera" };
  const input = { ...state, layout: "single", sourceLeaseIds: [id], activeSourceLeaseId: id, availableSources: [available] };
  const result = normalizeNativeSourceSceneState(input, query, now);
  assert.equal(Object.isFrozen(result.availableSources), true); assert.equal(Object.isFrozen(result.availableSources[0]), true);
  assert.equal(Object.isFrozen(result.sourceLeaseIds), true);
  available.sourceKind = "screen"; input.sourceLeaseIds.length = 0;
  assert.equal(result.availableSources[0].sourceKind, "camera"); assert.deepEqual(result.sourceLeaseIds, [id]);
  // Source withdrawal may leave the configured slot as slate. This is not a grant.
  assert.deepEqual(normalizeNativeSourceSceneState({ ...result, availableSources: [] }, query, now).availableSources, []);
  for (const list of [[{ sourceLeaseId: id, sourceKind: "microphone" }], [available, available],
    [{ ...available, consent: true }], [{ ...available, sourceLeaseId: "bad" }], Array(81).fill(available)])
    assert.throws(() => normalizeNativeSourceSceneState({ ...state, availableSources: list }, query, now));
});

test("rejection is a fixed correlated refusal, not an error-text or revision channel", () => {
  for (const change of [{ commandId: "scn_bbbbbbbbbbbbbbbb" }, { reasonCode: "private error text" },
    { sceneRevision: 2 }, { observedAt: now - 1001 }, { observedAt: now + 1001 }, { observedAt: query.expiresAt }])
    assert.throws(() => normalizeNativeSourceSceneRejection({ ...rejected, ...change }, command, now));
  assert.throws(() => normalizeNativeSourceSceneRejection(rejected, command, command.expiresAt));
});
