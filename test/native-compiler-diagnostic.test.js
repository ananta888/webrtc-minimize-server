import assert from "node:assert/strict";
import test from "node:test";
import { nativeCompilerDiagnostic } from "./helpers/native-compiler-diagnostic.mjs";

test("compiler diagnostics classify only bounded known failures without exposing output", () => {
  for (const [result, reason] of [
    [{ error: { code: "ETIMEDOUT" } }, "deadline"],
    [{ error: { code: "ENOBUFS" } }, "output_limit"],
    [{ stderr: "runtime: failed to create new OS thread (have 8 already; errno=11)" }, "resource_unavailable"],
    [{ stderr: "fatal error: newosproc" }, "resource_unavailable"],
    [{ stderr: "fork/exec synthetic: resource temporarily unavailable" }, "resource_unavailable"],
    [{ stderr: "write synthetic: no space left on device" }, "storage_unavailable"],
    [{ stderr: "go: reading synthetic: connection refused" }, "dependency_unavailable"],
    [{ stderr: "unexpected compiler issue" }, "unknown"],
  ]) {
    const value = nativeCompilerDiagnostic({ status: 2, signal: "SIGTERM", ...result,
      stdout: "synthetic-private-output", env: { KEY: "synthetic-private-output" } });
    assert.deepEqual(value, { phase: "native-source-compile", reason, exitCode: 2, signal: "SIGTERM" });
    assert.ok(Object.isFrozen(value));
    assert.equal(JSON.stringify(value).includes("synthetic"), false);
  }
});

test("unknown and oversized compiler inputs cannot expand diagnostic fields", () => {
  for (const result of [null, undefined, {}, { status: "2", signal: "secret", stderr: { toString() { throw new Error("coercion"); } } },
    { status: 999, signal: {}, stderr: "x".repeat(65536) + "fatal error: newosproc" }]) {
    assert.deepEqual(nativeCompilerDiagnostic(result), { phase: "native-source-compile", reason: "unknown", exitCode: null, signal: null });
  }
});
