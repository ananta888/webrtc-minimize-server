import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startSceneProcess } from "./helpers/native-scene-processes.mjs";

function fixture(onKill = () => {}) {
  const child = new EventEmitter(), signals = [];
  child.kill = signal => { signals.push(signal); onKill(child); return true; };
  const process = startSceneProcess("/owned/binary", { PATH: "/fixed/path" }, (executable, args, options) => {
    assert.equal(executable, "/owned/binary"); assert.deepEqual(args, []);
    assert.deepEqual(options, { env: { PATH: "/fixed/path" }, stdio: "ignore", detached: false });
    return child;
  });
  return { process, child, signals };
}

test("scene process confirms clean termination without inheriting runtime environment", async () => {
  const f = fixture(child => queueMicrotask(() => child.emit("close", 0, null)));
  assert.equal(f.process.alive(), true);
  await f.process.close(); await f.process.close();
  assert.equal(f.process.alive(), false); assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("an already clean exited scene process needs no extra signal", async () => {
  const f = fixture(); f.child.emit("close", 0, null);
  await f.process.close(); assert.deepEqual(f.signals, []);
});

for (const reason of ["exit-code", "signal", "spawn-error"]) {
  test(`scene cleanup keeps ${reason} uncertain instead of freeing its output tree`, async () => {
    const f = fixture();
    if (reason === "spawn-error") f.child.emit("error", new Error("synthetic private error"));
    f.child.emit("close", reason === "exit-code" ? 1 : 0, reason === "signal" ? "SIGKILL" : null);
    assert.equal(f.process.alive(), false);
    await assert.rejects(f.process.close(), /^Error: scene_fixture_process_exit_unconfirmed$/);
    await assert.rejects(f.process.close(), /^Error: scene_fixture_process_exit_unconfirmed$/);
    assert.deepEqual(f.signals, []);
  });
}

test("a failed exit after requested SIGTERM is not a graceful cleanup", async () => {
  const f = fixture(child => queueMicrotask(() => child.emit("close", 1, null)));
  await assert.rejects(f.process.close(), /scene_fixture_process_exit_unconfirmed/);
  assert.deepEqual(f.signals, ["SIGTERM"]);
});
