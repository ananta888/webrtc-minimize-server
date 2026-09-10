import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sceneObserverOverlay, sceneProcessObserver } from "./native-scene-observer.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

/** Production binaries by default; explicit test overlay never adds a network/decrypt endpoint. */
export async function nativeSceneProcesses(t, { observeSourceState = false } = {}) {
  assert.equal(typeof observeSourceState, "boolean");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webrtc-coupled-scene-"));
  const children = [];
  let compilerCleanupUncertain = false;
  t.after(async () => {
    let failure;
    for (const child of children.reverse()) {
      try { await child.close(); } catch { failure = new Error("scene_fixture_process_cleanup_failed"); }
    }
    // Preserve the owned directory on uncertain process cleanup; never unlink
    // an output tree while its encoder might still own it.
    if (failure || compilerCleanupUncertain) throw failure || new Error("scene_fixture_compiler_cleanup_failed");
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, "output"), { mode: 0o700 });
  await fs.mkdir(path.join(directory, "empty-ca"), { mode: 0o700 });
  let localGo = true;
  try { await execute("go", ["version"], { timeout: 10_000, maxBuffer: 4096, signal: t.signal }); }
  catch { localGo = false; }
  try {
    await execute("ffmpeg", ["-version"], { timeout: 5000, maxBuffer: 32_768 });
  } catch { throw new Error("scene_fixture_requires_local_ffmpeg"); }
  for (const [name, module] of [["packager", "native-broadcast-packager"], ["origin", "broadcast-hls-origin"]]) {
    const container = `webrtc-scene-compile-${randomUUID()}`;
    const overlay = observeSourceState && name === "packager"
      ? ["-overlay", await sceneObserverOverlay(path.join(root, module), directory, localGo)] : [];
    try {
      await execute(localGo ? "go" : "docker", localGo ? ["build", ...overlay, "-o", path.join(directory, name), "."] : [
        "run", "--rm", "--name", container, "-e", "CGO_ENABLED=0",
        "-v", `${path.join(root, module)}:/src:ro`, "-v", `${directory}:/out`, "-w", "/src",
        "golang:1.24-alpine", "go", "build", ...overlay, "-o", `/out/${name}`, ".",
      ], {
        cwd: path.join(root, module), env: { ...process.env, CGO_ENABLED: "0" },
        timeout: 90_000, maxBuffer: 32_768, signal: t.signal,
      });
    } catch { throw new Error("scene_fixture_native_compilation_failed"); }
    finally {
      if (!localGo) try { await execute("docker", ["rm", "--force", container], { timeout: 5000, maxBuffer: 4096 }); }
      catch (error) {
        if (!/No such container/.test(String(error.stderr || ""))) {
          compilerCleanupUncertain = true; throw new Error("scene_fixture_compiler_cleanup_failed");
        }
      }
    }
  }
  return {
    directory, output: path.join(directory, "output"),
    start(name, environment) {
      assert.ok(["packager", "origin"].includes(name));
      const process = startSceneProcess(path.join(directory, name), {
        PATH: globalThis.process.env.PATH,
        SSL_CERT_FILE: path.join(directory, "cert.pem"), SSL_CERT_DIR: path.join(directory, "empty-ca"),
        ...environment,
      }, spawn, observeSourceState && name === "packager");
      children.push(process); return process;
    },
  };
}

export function startSceneProcess(executable, environment, create = spawn, observed = false) {
  const child = create(executable, [], { env: environment, stdio: observed ? ["ignore", "pipe", "ignore"] : "ignore", detached: false });
  const observe = observed ? sceneProcessObserver(child) : async () => null;
  let terminal = false, failed = false;
  const finished = new Promise(resolve => {
    child.once("error", () => { failed = true; });
    child.once("close", (code, signal) => { failed ||= code !== 0 || signal != null; terminal = true; resolve(); });
  });
  const bounded = async ms => {
    let timer;
    try {
      return await Promise.race([finished.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { clearTimeout(timer); }
  };
  return {
    observe,
    alive: () => !terminal && !failed,
    async close() {
      if (terminal) {
        if (failed) throw new Error("scene_fixture_process_exit_unconfirmed");
        return;
      }
      child.kill("SIGTERM");
      if (await bounded(5000)) {
        if (failed) throw new Error("scene_fixture_process_exit_unconfirmed");
        return;
      }
      child.kill("SIGKILL"); await bounded(2000);
      // Forced kill is not proof that FFmpeg children cleaned their output.
      throw new Error("scene_fixture_graceful_stop_failed");
    },
  };
}
