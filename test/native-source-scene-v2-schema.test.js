import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { normalizeNativeSourceScene } from "../src/native-source-scene.js";

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
for (const name of ["source-scene", "source-scene-query", "source-scene-state", "source-scene-applied", "source-scene-rejected"]) {
  test(`native ${name} v2 has a closed shared fixture without changing v1`, () => {
    const schema = version => json(`../contracts/native-packager/${name}.v${version}.schema.json`);
    const fixture = version => json(`../native-broadcast-packager/testdata/${name}.v${version}.json`);
    const v1 = new Ajv({ strict: true }).compile(schema(1)), v2 = new Ajv({ strict: true }).compile(schema(2));
    const value = fixture(2);
    assert.ok(v2(value)); assert.ok(v1(fixture(1)));
    assert.equal(v1(value), false); assert.equal(v2(fixture(1)), false);
    assert.equal(v2({ ...value, unexpected: true }), false);
    assert.equal(v2({ ...value, version: 3 }), false);
    if (["source-scene", "source-scene-state"].includes(name)) {
      for (const sourceFits of [null, ["stretch"], [1], Array(21).fill("cover")]) {
        assert.equal(v2({ ...value, sourceFits }), false);
      }
      const missing = { ...value }; delete missing.sourceFits;
      assert.equal(v2(missing), false);
      assert.equal(value.sourceFits.length, value.sourceLeaseIds.length);
    }
  });
}

test("native-only intermediate v2 is not silently forwarded by the existing Node v1 adapter", () => {
  const value = json("../native-broadcast-packager/testdata/source-scene.v2.json");
  assert.throws(() => normalizeNativeSourceScene(value, value.issuedAt), /invalid_native_source_scene/);
});
