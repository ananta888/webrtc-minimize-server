import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeNativePackagerCapability, supportsNativeSourceAudioV1, supportsNativeSourceSignalV1, supportsNativeSourceSceneV1 } from "../src/native-packager-policy.js";
import { parseNativePackagerMessage } from "../src/native-packager-control.js";

test("v3 audio capability is explicit, closed and preserves source/scene support", () => {
  const message = JSON.parse(readFileSync(new URL("./fixtures/native-source-capability.v3.json", import.meta.url)));
  const schema = JSON.parse(readFileSync(new URL("../contracts/native-packager/capability.v3.schema.json", import.meta.url)));
  const validate = new Ajv2020({ strict: true }).compile(schema), report = message.capability, now = report.observedAt;
  assert.equal(validate(report), true); assert.deepEqual(parseNativePackagerMessage(JSON.stringify(message)), message);
  const normalized = normalizeNativePackagerCapability(report, now);
  assert.equal(supportsNativeSourceAudioV1(normalized), true);
  assert.equal(supportsNativeSourceSignalV1(normalized), true); assert.equal(supportsNativeSourceSceneV1(normalized), true);
  for (const field of Object.keys(report)) {
    const missing = { ...report }; delete missing[field];
    assert.equal(validate(missing), false); assert.throws(() => normalizeNativePackagerCapability(missing, now));
  }
  for (const extra of [{ sourceAudioControlVersion: 2 }, { sourceAudioControlVersion: true }, { sourcePrograms: false }, { capabilityVersion: 2 }, { authority: true }]) {
    assert.equal(validate({ ...report, ...extra }), false); assert.throws(() => normalizeNativePackagerCapability({ ...report, ...extra }, now));
  }
  const legacy = JSON.parse(readFileSync(new URL("./fixtures/native-source-capability.v2.json", import.meta.url))).capability;
  assert.equal(supportsNativeSourceAudioV1(normalizeNativePackagerCapability(legacy, now)), false);
});
