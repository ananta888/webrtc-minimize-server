import assert from "node:assert/strict";
import test from "node:test";
import { transformFailureCounts } from "./helpers/machine-transform-observation.mjs";

test("transform observations count only the closed code alphabet", () => {
  const empty = transformFailureCounts([]);
  assert.equal(empty.valid, true); assert.equal(empty.inspected, 0); assert.equal(empty.truncated, false);
  assert.equal(Object.keys(empty.counts).length, 7);
  const codes = Object.keys(empty.counts).filter(code => code !== "unknown");
  const actual = transformFailureCounts([...codes, ...codes]);
  assert.equal(actual.inspected, 12);
  for (const code of codes) assert.equal(actual.counts[code], 2);
  assert.equal(actual.counts.unknown, 0);
});

test("unknown strings, objects and prototype names never become report data", () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const actual = transformFailureCounts([marker, "__proto__", "constructor", null, 42,
    { toString() { throw Error("must_not_coerce"); } }, { contextId: marker, key: marker }]);
  assert.equal(actual.counts.unknown, 7);
  assert.equal(JSON.stringify(actual).includes(marker), false);
  assert.equal(Object.hasOwn(actual.counts, "__proto__"), false);
});

test("diagnostics inspect at most 128 values and reveal truncation without reading the tail", () => {
  const values = Array(129).fill("media_envelope_version");
  Object.defineProperty(values, 128, { get() { throw Error("tail_must_not_be_read"); } });
  const actual = transformFailureCounts(values);
  assert.equal(actual.inspected, 128); assert.equal(actual.truncated, true);
  assert.equal(actual.counts.media_envelope_version, 128);
  assert.equal(transformFailureCounts(values.slice(0, 128)).truncated, false);
});

test("malformed source collections are explicitly invalid", () => {
  for (const value of [null, 1, "private string", {}, { length: 1 }, new Set()]) {
    const actual = transformFailureCounts(value);
    assert.equal(actual.valid, false); assert.equal(actual.inspected, 0);
    assert.equal(Object.values(actual.counts).every(count => count === 0), true);
  }
});

test("browser callback reads only its test-owned global collection without mutating it", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "__transformErrors");
  const values = Object.freeze(["media_frame_type"]);
  Object.defineProperty(globalThis, "__transformErrors", { configurable: true, value: values });
  try {
    assert.equal(transformFailureCounts().counts.media_frame_type, 1);
    assert.deepEqual(values, ["media_frame_type"]);
  } finally {
    if (before) Object.defineProperty(globalThis, "__transformErrors", before);
    else delete globalThis.__transformErrors;
  }
});
