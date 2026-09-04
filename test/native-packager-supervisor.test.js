import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { admitNativePackager } from "../src/native-packager-policy.js";
import {
  NativePackagerSupervisor,
  NativePackagerSupervisorError,
} from "../src/native-packager-supervisor.js";

const now = 1_800_000_000_000;
const capability = {
  capabilityVersion: 1, agentId: "mini-packager", tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa",
  agentVersion: "1.0.0", ffmpegVersion: "6.1.1",
  videoEncoders: ["libx264", "h264_nvenc"], audioEncoders: ["aac"],
  hardwareClass: "large", cpuClass: "high", gpuClass: "dedicated",
  uploadClass: "over-15mbit", energyClass: "ac", health: "healthy",
  maximumRenditions: 3, maximumPixelsPerSecond: 1280 * 720 * 30,
  consentedRoomIds: ["room-alpha"], observedAt: now, expiresAt: now + 30_000,
};
const request = {
  requestVersion: 1, trigger: "user-action", tenantId: capability.tenantId,
  ownerSubjectRef: capability.ownerSubjectRef, roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 7,
  resourceRef: "res_aaaaaaaaaaaaaaaa", requestedRenditions: 3,
  allowHardwareAcceleration: true,
};

class FakeStdin extends EventEmitter {
  writable = true;
  chunks = [];
  endCallback;

  write(chunk) {
    if (!this.writable) return false;
    this.chunks.push(Buffer.from(chunk));
    return this.chunks.length !== 1;
  }

  end() { this.endCallback?.(); }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stderr = { resume() {} };
  killed = false;

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 137, "SIGKILL"));
    return true;
  }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition_not_reached");
}

test("supervisor applies hard backpressure, hardware fallback, fencing and cleanup", async (context) => {
  const admission = admitNativePackager(capability, request, now);
  const root = await mkdtemp(path.join(os.tmpdir(), "native-supervisor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const processes = [];
  const launches = [];
  const states = [];
  const supervisor = new NativePackagerSupervisor({
    spawnProcess(command, args, options) {
      const child = new FakeChild();
      processes.push(child);
      launches.push({ command, args, options });
      return child;
    },
    onState: (state) => states.push(state),
    killAfterMs: 100,
  });
  const scope = { programId: admission.programId, programEpoch: admission.programEpoch };

  const started = await supervisor.start(admission, root);
  assert.equal(started.state, "running");
  assert.equal(started.encoder, "h264_nvenc");
  assert.equal(launches[0].command, "ffmpeg");
  assert.equal(launches[0].options.shell, false);
  assert.deepEqual(launches[0].options.stdio, ["pipe", "ignore", "pipe"]);
  assert.equal((await stat(path.join(root, admission.resourceRef, "high"))).isDirectory(), true);
  await assert.rejects(supervisor.start(admission, root), /already_running/);

  assert.deepEqual(supervisor.ingest(scope, Buffer.from("first")), {
    accepted: true,
    reason: "backpressure-engaged",
  });
  assert.deepEqual(supervisor.ingest(scope, Buffer.from("dropped")), {
    accepted: false,
    reason: "backpressure",
  });
  processes[0].stdin.emit("drain");
  assert.equal(supervisor.ingest(scope, Buffer.from("second")).accepted, true);
  assert.throws(
    () => supervisor.ingest(scope, Buffer.alloc(1024 * 1024 + 1)),
    /invalid_native_packager_input_chunk/,
  );
  assert.throws(
    () => supervisor.snapshot({ ...scope, programEpoch: 8 }),
    new NativePackagerSupervisorError("native_packager_fence_mismatch", 409),
  );

  processes[0].emit("close", 1, null);
  await until(() => processes.length === 2);
  const degraded = supervisor.snapshot(scope);
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.encoder, "libx264");
  assert.equal(degraded.fallbackCount, 1);
  assert.equal(states.some(({ state }) => state === "degraded"), true);

  processes[1].stdin.endCallback = () => queueMicrotask(() => processes[1].emit("close", 0, null));
  assert.equal(await supervisor.stop(scope), true);
  await assert.rejects(stat(path.join(root, admission.resourceRef)), { code: "ENOENT" });
  assert.equal(await supervisor.stop(scope), false);
});

test("supervisor drops input while not runnable and force-kills a stuck FFmpeg", async (context) => {
  const admission = admitNativePackager({ ...capability, videoEncoders: ["libx264"] }, request, now);
  const root = await mkdtemp(path.join(os.tmpdir(), "native-supervisor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const processes = [];
  const supervisor = new NativePackagerSupervisor({
    spawnProcess() {
      const child = new FakeChild();
      processes.push(child);
      return child;
    },
    killAfterMs: 100,
  });
  const scope = { programId: admission.programId, programEpoch: admission.programEpoch };
  await supervisor.start(admission, root);
  const stopping = supervisor.stop(scope);
  assert.deepEqual(supervisor.ingest(scope, Buffer.from("late")), {
    accepted: false,
    reason: "not-running",
  });
  await stopping;
  assert.equal(processes[0].killed, true);
});
