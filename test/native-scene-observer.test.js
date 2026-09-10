import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { instrumentSceneMain, parseSceneObservation, sceneObserverOverlay, sceneProcessObserver } from "./helpers/native-scene-observer.mjs";
import { startSceneProcess } from "./helpers/native-scene-processes.mjs";

const sample = () => ({ fixture: "source-state-v1", available: true, programClosed: false, sources: [{
  kind: "camera", lazyAvailable: true, closed: false, observed: true, pending: false, decoder: true,
  needKey: false, waitingClock: false, clockAvailable: true, clockClosed: false, clockBound: true,
  reports: 2, clockFailure: 0, uncertain: false, decoderAvailable: true, decoderClosed: false,
  decoderStarted: true, queued: 1, timestamps: 2, mixerAvailable: true, mixerClosed: false,
  mixerStarted: true, current: true, pendingFrames: 1,
}] });
const line = () => JSON.stringify(sample()) + "\n";
function processFixture() {
  const child = new EventEmitter(); child.stdout = new EventEmitter();
  const signals = []; child.kill = signal => { signals.push(signal); return true; };
  return { child, signals, observe: sceneProcessObserver(child, 15) };
}

test("scene observation accepts only fixed booleans, enums and bounded counts", () => {
  assert.deepEqual(parseSceneObservation(line()), sample());
  for (const value of [null, {}, [], { ...sample(), secret: "canary" }, { ...sample(), sources: Array(81).fill(sample().sources[0]) }]) {
    assert.equal(parseSceneObservation(JSON.stringify(value)), null);
  }
  for (const changes of [{ kind: "private-source-canary" }, { reports: 65536 }, { clockFailure: 8 },
    { queued: 3 }, { timestamps: 9 }, { pendingFrames: 9 }, { decoderStarted: 1 }, { reports: -1 },
    { reports: 1.5 }, { token: "secret-canary" }]) {
    const value = sample(); Object.assign(value.sources[0], changes);
    assert.equal(parseSceneObservation(JSON.stringify(value)), null);
  }
  const missing = sample(); delete missing.sources[0].closed;
  assert.equal(parseSceneObservation(JSON.stringify(missing)), null);
  assert.equal(parseSceneObservation("x".repeat(65537)), null);
  assert.equal(parseSceneObservation("{"), null);
});

test("only two requested snapshots are read; unsolicited data and parallel reads do not create requests", async () => {
  const f = processFixture();
  f.child.stdout.emit("data", Buffer.from("unsolicited-private-canary\n"));
  const first = f.observe(); assert.equal(await f.observe(), null);
  f.child.stdout.emit("data", Buffer.from(line().slice(0, 50)));
  f.child.stdout.emit("data", Buffer.from(line().slice(50)));
  assert.deepEqual(await first, sample());
  const second = f.observe(); f.child.stdout.emit("data", Buffer.from(line()));
  assert.deepEqual(await second, sample()); assert.equal(await f.observe(), null);
  assert.deepEqual(f.signals, ["SIGUSR1", "SIGUSR1"]);
});

test("timeout, process close, oversized or malformed output terminate observation without exposing bytes", async () => {
  for (const mode of ["timeout", "close", "pipe-error", "oversize", "malformed", "extra-line", "kill-false", "kill-throws"]) {
    const f = processFixture();
    if (mode === "kill-false") f.child.kill = () => false;
    if (mode === "kill-throws") f.child.kill = () => { throw new Error("private-canary"); };
    const pending = f.observe();
    if (mode === "close") f.child.emit("close", 0, null);
    if (mode === "pipe-error") f.child.stdout.emit("error", new Error("private-canary"));
    if (mode === "oversize") f.child.stdout.emit("data", Buffer.alloc(65537, 120));
    if (mode === "malformed") f.child.stdout.emit("data", Buffer.from("private-canary\n"));
    if (mode === "extra-line") f.child.stdout.emit("data", Buffer.from(line() + "private-canary\n"));
    assert.equal(await pending, null, mode);
    f.child.stdout.emit("data", Buffer.from(line()));
    assert.equal(await f.observe(), null, mode);
  }
});

test("instrumented process opts into stdout only; default binaries have no signal observer", async () => {
  const f = processFixture();
  const process = startSceneProcess("/owned/test-binary", {}, (_file, _args, options) => {
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]); return f.child;
  }, true);
  const pending = process.observe(); f.child.stdout.emit("data", Buffer.from(line()));
  assert.deepEqual(await pending, sample());
  f.child.emit("close", 0, null); await process.close();
});

test("Go overlay alters one owned main copy, fails closed on source drift and leaves release source intact", async t => {
  const module = path.resolve("native-broadcast-packager");
  const original = await fs.readFile(path.join(module, "main.go"), "utf8");
  const observer = await fs.readFile(new URL("./helpers/native-scene-observer.go.txt", import.meta.url), "utf8");
  const copy = instrumentSceneMain(original, observer);
  assert.ok(copy.includes("observeSceneFixture(ctx, client)"));
  assert.throws(() => instrumentSceneMain(copy, observer), /overlay_shape/);
  assert.throws(() => instrumentSceneMain(original + original, observer), /overlay_shape/);
  assert.throws(() => instrumentSceneMain("package main", observer), /overlay_shape/);
  for (const local of [true, false]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webrtc-scene-overlay-test-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const overlay = await sceneObserverOverlay(module, directory, local);
    assert.equal(overlay, local ? path.join(directory, "observer-overlay.json") : "/out/observer-overlay.json");
    const data = JSON.parse(await fs.readFile(path.join(directory, "observer-overlay.json"), "utf8"));
    assert.deepEqual(data, { Replace: { [local ? path.join(module, "main.go") : "/src/main.go"]:
      local ? path.join(directory, "observed-main.go") : "/out/observed-main.go" } });
    assert.equal(await fs.readFile(path.join(directory, "observed-main.go"), "utf8"), copy);
    assert.equal((await fs.stat(path.join(directory, "observed-main.go"))).mode & 0o777, 0o600);
    await assert.rejects(sceneObserverOverlay(module, directory, local), { code: "EEXIST" });
  }
  assert.equal(await fs.readFile(path.join(module, "main.go"), "utf8"), original);
});
