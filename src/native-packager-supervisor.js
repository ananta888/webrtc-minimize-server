import { spawn } from "node:child_process";
import fs from "node:fs/promises";

import { nativePackagerPipelineCandidates } from "./native-packager-policy.js";

const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const MAX_INPUT_CHUNK_BYTES = 1024 * 1024;

export class NativePackagerSupervisorError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NativePackagerSupervisorError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new NativePackagerSupervisorError(code, status); }

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function scopeOf(value, closed = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (closed && Object.keys(value).some((field) => !new Set(["programId", "programEpoch"]).has(field)))
    || !PROGRAM.test(value.programId || "")
    || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 1) {
    fail("invalid_native_packager_scope");
  }
  return value;
}

function publicSnapshot(session) {
  return Object.freeze({
    programId: session.programId,
    programEpoch: session.programEpoch,
    state: session.state,
    encoder: session.encoder,
    fallbackCount: session.fallbackCount,
    acceptedBytes: session.acceptedBytes,
    droppedChunks: session.droppedChunks,
    backpressured: session.backpressured,
  });
}

export class NativePackagerSupervisor {
  #sessions = new Map();
  #spawn;
  #fs;
  #killAfterMs;
  #maxChunkBytes;
  #onState;

  constructor({
    spawnProcess = spawn,
    filesystem = fs,
    killAfterMs = 5_000,
    maxInputChunkBytes = MAX_INPUT_CHUNK_BYTES,
    onState = () => {},
  } = {}) {
    if (typeof spawnProcess !== "function" || !filesystem
      || typeof filesystem.mkdir !== "function" || typeof filesystem.rm !== "function"
      || !Number.isSafeInteger(killAfterMs) || killAfterMs < 100 || killAfterMs > 30_000
      || !Number.isSafeInteger(maxInputChunkBytes) || maxInputChunkBytes < 1_200
      || maxInputChunkBytes > MAX_INPUT_CHUNK_BYTES || typeof onState !== "function") {
      fail("invalid_native_packager_supervisor_configuration", 500);
    }
    this.#spawn = spawnProcess;
    this.#fs = filesystem;
    this.#killAfterMs = killAfterMs;
    this.#maxChunkBytes = maxInputChunkBytes;
    this.#onState = onState;
  }

  async start(admission, outputRoot) {
    const scope = scopeOf(admission, false);
    if (this.#sessions.has(scope.programId)) fail("native_packager_program_already_running", 409);
    const candidates = nativePackagerPipelineCandidates(admission, outputRoot);
    const outputDirectory = candidates[0].outputDirectory;
    await this.#fs.rm(outputDirectory, { recursive: true, force: true });
    for (const rendition of admission.renditions) {
      await this.#fs.mkdir(`${outputDirectory}/${rendition.id}`, { recursive: true });
    }
    const completion = deferred();
    const session = {
      programId: scope.programId,
      programEpoch: scope.programEpoch,
      candidates,
      candidateIndex: 0,
      outputDirectory,
      renditionIds: Object.freeze(admission.renditions.map(({ id }) => id)),
      state: "starting",
      encoder: admission.videoEncoder,
      fallbackCount: 0,
      acceptedBytes: 0,
      droppedChunks: 0,
      backpressured: false,
      stopping: false,
      generation: 0,
      endingGeneration: 0,
      killTimer: null,
      child: null,
      completion,
    };
    this.#sessions.set(scope.programId, session);
    this.#launch(session);
    return publicSnapshot(session);
  }

  ingest(scopeValue, chunk) {
    const session = this.#session(scopeValue);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > this.#maxChunkBytes) {
      fail("invalid_native_packager_input_chunk");
    }
    if (session.stopping || !session.child || !new Set(["running", "degraded"]).has(session.state)) {
      session.droppedChunks += 1;
      return Object.freeze({ accepted: false, reason: "not-running" });
    }
    if (session.backpressured) {
      session.droppedChunks += 1;
      return Object.freeze({ accepted: false, reason: "backpressure" });
    }
    let writable;
    try {
      writable = session.child.stdin.write(chunk);
    } catch {
      session.droppedChunks += 1;
      return Object.freeze({ accepted: false, reason: "input-closed" });
    }
    session.acceptedBytes += chunk.byteLength;
    if (!writable) {
      session.backpressured = true;
      const child = session.child;
      child.stdin.once("drain", () => {
        if (session.child === child && !session.stopping) session.backpressured = false;
      });
    }
    return Object.freeze({ accepted: true, reason: writable ? "accepted" : "backpressure-engaged" });
  }

  snapshot(scopeValue) {
    return publicSnapshot(this.#session(scopeValue));
  }

  async stop(scopeValue) {
    const scope = scopeOf(scopeValue);
    const session = this.#sessions.get(scope.programId);
    if (!session) return false;
    if (session.programEpoch !== scope.programEpoch) fail("native_packager_fence_mismatch", 409);
    if (!session.stopping) {
      session.stopping = true;
      session.state = "stopping";
      this.#notify(session);
      try { session.child?.stdin.end(); } catch { /* child close remains authoritative */ }
      const child = session.child;
      session.killTimer = setTimeout(() => {
        if (session.child === child && !child?.killed) child?.kill("SIGKILL");
      }, this.#killAfterMs);
    }
    await session.completion.promise;
    return true;
  }

  async destroy() {
    await Promise.all([...this.#sessions.values()].map((session) => this.stop({
      programId: session.programId,
      programEpoch: session.programEpoch,
    })));
  }

  #session(scopeValue) {
    const scope = scopeOf(scopeValue);
    const session = this.#sessions.get(scope.programId);
    if (!session) fail("native_packager_program_not_running", 404);
    if (session.programEpoch !== scope.programEpoch) fail("native_packager_fence_mismatch", 409);
    return session;
  }

  #launch(session) {
    const pipeline = session.candidates[session.candidateIndex];
    const generation = ++session.generation;
    session.endingGeneration = 0;
    session.encoder = pipeline.args[pipeline.args.indexOf("-c:v:0") + 1];
    session.state = session.candidateIndex === 0 ? "running" : "degraded";
    session.backpressured = false;
    let child;
    try {
      child = this.#spawn(pipeline.command, pipeline.args, {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      void this.#processEnded(session, generation);
      return;
    }
    session.child = child;
    child.stderr?.resume?.();
    child.once("error", () => { void this.#processEnded(session, generation); });
    child.once("close", () => { void this.#processEnded(session, generation); });
    this.#notify(session);
  }

  async #processEnded(session, generation) {
    if (generation !== session.generation || session.endingGeneration === generation) return;
    session.endingGeneration = generation;
    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = null;
    }
    session.child = null;
    session.backpressured = false;
    if (!session.stopping && session.candidateIndex + 1 < session.candidates.length) {
      session.candidateIndex += 1;
      session.fallbackCount += 1;
      await this.#fs.rm(session.outputDirectory, { recursive: true, force: true });
      for (const renditionId of session.renditionIds) {
        await this.#fs.mkdir(`${session.outputDirectory}/${renditionId}`, { recursive: true });
      }
      if (session.stopping) {
        session.state = "stopped";
        this.#notify(session);
        this.#sessions.delete(session.programId);
        await this.#fs.rm(session.outputDirectory, { recursive: true, force: true });
        session.completion.resolve(publicSnapshot(session));
        return;
      }
      this.#launch(session);
      return;
    }
    session.state = session.stopping ? "stopped" : "failed";
    this.#notify(session);
    this.#sessions.delete(session.programId);
    await this.#fs.rm(session.outputDirectory, { recursive: true, force: true });
    session.completion.resolve(publicSnapshot(session));
  }

  #notify(session) {
    try { this.#onState(publicSnapshot(session)); } catch { /* observation cannot control media */ }
  }
}
