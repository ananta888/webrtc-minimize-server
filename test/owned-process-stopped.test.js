import assert from "node:assert/strict";
import test from "node:test";
import { ownedProcessStopped } from "./helpers/owned-process-stopped.mjs";

test("owned process observation distinguishes running and zombie states at the exact pinned path", async () => {
  for (const state of ["R", "S", "D", "T", "Z"]) {
    assert.equal(await ownedProcessStopped(12345, async (path, encoding) => {
      assert.equal(path, "/proc/12345/status"); assert.equal(encoding, "utf8");
      return `Name:\tfixture\nState:\t${state} (fixture)\n`;
    }), state === "Z");
  }
});
test("both absent-at-open and disappeared-during-read are stopped", async () => {
  for (const code of ["ENOENT", "ESRCH"]) assert.equal(await ownedProcessStopped(12345,
    async () => { throw Object.assign(new Error(), { code }); }), true);
});
test("unknown and permission errors cannot masquerade as successful process cleanup", async () => {
  for (const code of ["EACCES", "EIO", "EPERM", undefined]) {
    const failure = Object.assign(new Error("read failed"), { code });
    await assert.rejects(ownedProcessStopped(12345, async () => { throw failure; }), error => error === failure);
  }
});
test("invalid process IDs are rejected before touching proc", async () => {
  for (const pid of [undefined, null, "12345", -12345, 0, 1, 1.5, Infinity])
    await assert.rejects(ownedProcessStopped(pid, () => assert.fail("must not read")), /invalid_owned_process/);
});
