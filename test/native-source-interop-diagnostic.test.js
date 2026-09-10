import assert from "node:assert/strict";
import test from "node:test";
import { nativeSourceInteropDiagnostic } from "./helpers/native-source-interop-diagnostic.mjs";

const fixture = { fixture: "diagnostic", frames: 200, keyframes: 1, decoded: 200, closed: true,
  failure: 5, phase: "receiver-ended", renewals: 7, leaseRemainingMs: -1, parentAllowed: true };

test("source interop failure projects bounded phase and accepted lease state, not authority", () => {
  const { fixture: _type, ...expected } = fixture;
  assert.deepEqual(nativeSourceInteropDiagnostic(fixture), expected);
  for (const phase of ["prepare", "waiting", "receiver-ended", "deadline", "renewal", "control", "media-validation"]) {
    assert.equal(nativeSourceInteropDiagnostic({ ...fixture, phase }).phase, phase);
  }
});

test("source interop observation rejects missing, unknown, coerced and out-of-bounds fields", () => {
  for (const key of Object.keys(fixture)) {
    const missing = { ...fixture }; delete missing[key];
    assert.equal(nativeSourceInteropDiagnostic(missing), null);
    assert.equal(nativeSourceInteropDiagnostic({ ...fixture, [key]: null }), null);
  }
  for (const patch of [{ extra: "not forwarded" }, { phase: "secret raw error" }, { fixture: "result" },
    { frames: "200" }, { frames: 100001 }, { keyframes: -1 }, { decoded: Infinity }, { failure: 9 },
    { failure: 1.5 }, { renewals: 33 }, { leaseRemainingMs: -35001 }, { leaseRemainingMs: 5001 },
    { closed: 1 }, { parentAllowed: "true" }]) {
    assert.equal(nativeSourceInteropDiagnostic({ ...fixture, ...patch }), null);
  }
  for (const value of [null, [], "", 1, Object.create(fixture)]) assert.equal(nativeSourceInteropDiagnostic(value), null);
});
