import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

for (const version of [1, 2]) for (const name of ["source-audio", "source-audio-query", "source-audio-applied", "source-audio-state", "source-audio-rejected"]) {
  test(`${name} v${version} shares the native fixture and rejects unknown, missing and null fields`, () => {
    const schema = JSON.parse(readFileSync(new URL(`../contracts/native-packager/${name}.v${version}.schema.json`, import.meta.url)));
    const fixture = JSON.parse(readFileSync(new URL(`../native-broadcast-packager/testdata/${name}.v${version}.json`, import.meta.url)));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...fixture, authority: true }), false);
    for (const key of Object.keys(fixture)) {
      const absent = structuredClone(fixture); delete absent[key];
      assert.equal(validate(absent), false, key);
      assert.equal(validate({ ...fixture, [key]: null }), false, key);
    }
    if (!fixture.sources) return;
    for (const key of Object.keys(fixture.sources[0])) {
      const absent = structuredClone(fixture); delete absent.sources[0][key];
      assert.equal(validate(absent), false, key);
      const nullValue = structuredClone(fixture); nullValue.sources[0][key] = null;
      assert.equal(validate(nullValue), false, key);
    }
    for (const extra of [{ leftGainQ15: -1 }, { rightGainQ15: 32769 }, { muted: "false" }, { decryptKey: "denied" }]) {
      const invalid = structuredClone(fixture); Object.assign(invalid.sources[0], extra);
      assert.equal(validate(invalid), false);
    }
    const large = structuredClone(fixture); large.sources = Array.from({ length: 81 }, (_, i) => ({ ...fixture.sources[0], sourceLeaseId: `sls_${String(i).padStart(16, "0")}` }));
    assert.equal(validate(large), false);
  });
}
