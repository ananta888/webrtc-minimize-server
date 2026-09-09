import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const kind of ["visual", "audio"]) {
  const gate = `MEET_${kind.toUpperCase()}_PACKAGED_GATE`;
  const source = `MEET_TEST_${kind.toUpperCase()}_SOURCE`;
  test(`${kind} private receive bridge does not execute during ordinary test discovery`, () => {
    const result = spawnSync(process.execPath, [`test/helpers/machine-${kind}-hub-bridge.mjs`], {
      env: { ...process.env, [gate]: "0", [source]: "invalid" }, encoding: "utf8", timeout: 5000, maxBuffer: 4096,
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, "");
  });
  test(`${kind} explicitly activated bridge rejects invalid profile before resources`, () => {
    const result = spawnSync(process.execPath, [`test/helpers/machine-${kind}-hub-bridge.mjs`], {
      env: { ...process.env, [gate]: "1", [source]: "invalid" }, encoding: "utf8", timeout: 5000, maxBuffer: 4096,
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { bridge_error: `test_${kind}_bridge_failed`, stage: "configuration" });
  });
}
