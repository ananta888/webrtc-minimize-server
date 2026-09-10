import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { normalizeNativePackagerCapability, supportsNativeSourceSceneV2, supportsNativeSourceAudioV3, supportsNativeSourceSceneV1 } from "../src/native-packager-policy.js";
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/native-source-capability.v6.json", import.meta.url)));
const schema = JSON.parse(fs.readFileSync(new URL("../contracts/native-packager/capability.v6.schema.json", import.meta.url)));
const validate = new Ajv({ strict: true }).compile(schema);
test("explicit normalized v6 scene support preserves audio output support without version guessing", () => {
  const value = fixture.capability;
  assert.ok(validate(value));
  const parsed = normalizeNativePackagerCapability(value, value.observedAt);
  assert.ok(supportsNativeSourceSceneV2(parsed)); assert.ok(supportsNativeSourceSceneV1(parsed)); assert.ok(supportsNativeSourceAudioV3(parsed));
  assert.equal(supportsNativeSourceSceneV2({ ...parsed, capabilityVersion: 5, agentVersion: "99.0.0" }), false);
  for (const patch of [{ sourceSceneControlVersion: undefined }, { sourceSceneControlVersion: 1 }, { sourcePrograms: false },
    { sourceAudioControlVersion: 2 }, { sourceAudioEncodingVersion: 2 }, { capabilityVersion: 7 }, { unexpected: true }]) {
    assert.throws(() => normalizeNativePackagerCapability({ ...value, ...patch }, value.observedAt), /invalid_native_packager_capability/);
  }
});
