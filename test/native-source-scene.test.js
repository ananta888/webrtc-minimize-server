import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { NATIVE_SOURCE_SCENE_LAYOUTS, normalizeNativeSourceScene, normalizeNativeSourceSceneReceipt } from "../src/native-source-scene.js";

const fixture = JSON.parse(readFileSync(new URL("../native-broadcast-packager/testdata/source-scene.v1.json", import.meta.url)));
const schema = name => JSON.parse(readFileSync(new URL(`../contracts/native-packager/${name}.v1.schema.json`, import.meta.url)));
const validate = new Ajv({ strict: true }).compile(schema("source-scene"));
const now = fixture.issuedAt;

test("shared native scene fixture and all existing layouts validate without granting authority", () => {
  for (const layout of NATIVE_SOURCE_SCENE_LAYOUTS) {
    const input = { ...fixture, layout }, output = normalizeNativeSourceScene(input, now);
    assert.equal(validate(output), true);
    assert.deepEqual(output, input); assert.equal(Object.isFrozen(output), true);
    assert.equal(Object.isFrozen(output.sourceLeaseIds), true);
    assert.notEqual(input.sourceLeaseIds, output.sourceLeaseIds);
  }
});

test("scene commands fail closed on malformed shape, scope fields, selection and time", () => {
  for (const change of [
    { version: 2 }, { type: "unknown" }, { extra: true }, { commandId: "scn_bad" },
    { assignmentId: "other" }, { programId: "other" }, { leaseId: "other" },
    { programEpoch: 0 }, { fencingRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedSceneRevision: Number.MAX_SAFE_INTEGER }, { expectedSceneRevision: .5 },
    { layout: "filter-expression" }, { sourceLeaseIds: null }, { sourceLeaseIds: {} },
    { sourceLeaseIds: Array(21).fill(fixture.sourceLeaseIds[0]) },
    { sourceLeaseIds: [fixture.sourceLeaseIds[0], fixture.sourceLeaseIds[0]] },
    { sourceLeaseIds: ["unknown"] }, { activeSourceLeaseId: null },
    { activeSourceLeaseId: fixture.sourceLeaseIds[0] },
    { layout: "single", activeSourceLeaseId: "sls_bbbbbbbbbbbbbbbb" },
    { issuedAt: now + 1001 }, { expiresAt: now }, { expiresAt: now + 4001 },
  ]) assert.throws(() => normalizeNativeSourceScene({ ...fixture, ...change }, now), /invalid_native_source_scene/);
  for (const time of [NaN, Infinity, -1, 0, "1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeNativeSourceScene(fixture, time), /invalid_native_source_scene/);
  }
  for (const field of Object.keys(fixture)) {
    const input = { ...fixture }; delete input[field];
    assert.throws(() => normalizeNativeSourceScene(input, now), /invalid_native_source_scene/);
  }
});

test("only single and active-speaker layouts may explicitly select an included source", () => {
  for (const layout of ["single", "active-speaker"]) {
    const command = normalizeNativeSourceScene({ ...fixture, layout, activeSourceLeaseId: fixture.sourceLeaseIds[0] }, now);
    assert.equal(validate(command), true);
  }
});

test("native receipt is a closed historical application result", () => {
  const receipt = JSON.parse(readFileSync(new URL("../native-broadcast-packager/testdata/source-scene-applied.v1.json", import.meta.url)));
  const valid = new Ajv({ strict: true }).compile(schema("source-scene-applied"));
  assert.equal(valid(receipt), true);
  assert.equal(valid({ ...receipt, authority: true }), false);
  assert.equal(valid({ ...receipt, sceneRevision: 1 }), false);
  assert.deepEqual(normalizeNativeSourceSceneReceipt(receipt, fixture, now), receipt);
  for (const field of Object.keys(receipt)) {
    assert.throws(() => normalizeNativeSourceSceneReceipt({ ...receipt, [field]: null }, fixture, now));
  }
  for (const change of [{ authority: true }, { sceneRevision: 3 }, { commandId: "scn_bbbbbbbbbbbbbbbb" },
    { appliedAt: now - 1001 }, { appliedAt: now + 1001 }, { appliedAt: fixture.expiresAt }]) {
    assert.throws(() => normalizeNativeSourceSceneReceipt({ ...receipt, ...change }, fixture, now));
  }
  assert.throws(() => normalizeNativeSourceSceneReceipt(receipt, fixture, fixture.expiresAt));
});
