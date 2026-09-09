import { randomBytes } from "node:crypto";
import { normalizeNativeSourceScene, normalizeNativeSourceSceneReceipt } from "./native-source-scene.js";
import { normalizeNativeSourceSceneQuery, normalizeNativeSourceSceneState, normalizeNativeSourceSceneRejection } from "./native-source-scene-query.js";

export class NativeSourceSceneError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const error = (code, status) => new NativeSourceSceneError(code, status);
const scopeKeys = ["packagerId", "assignmentId", "programId", "programRevision", "programEpoch", "leaseId", "fencingRevision"];
export const sameNativeSceneContext = (a, b) => a && b && a.socket === b.socket && a.generation === b.generation
  && a.member === b.member && scopeKeys.every(k => a[k] === b[k]);

/** Bounded correlation only; the caller supplies a fresh authoritative controller context. */
export class NativeSourceSceneBroker {
  #pending = new Map();
  #closed = false;
  constructor({ send, clock = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
    this.send = send; this.clock = clock; this.schedule = schedule; this.cancel = cancel;
  }

  request(selection, authorize, signal) {
    if (this.#closed || signal?.aborted) return Promise.reject(error("native_scene_cancelled"));
    let current, command, now;
    try {
      now = this.clock(); current = authorize(now);
      const fields = ["expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId"];
      if (selection !== null && (!selection || typeof selection !== "object" || Array.isArray(selection)
        || Object.keys(selection).length !== fields.length || Object.keys(selection).some(k => !fields.includes(k)))) {
        throw error("invalid_native_scene_selection", 400);
      }
      if (!current?.socket || !current.generation || !current.member || current.expiresAt <= now) throw error("native_scene_unavailable");
      if (this.#pending.size >= 128 || [...this.#pending.values()].some(p => p.context.packagerId === current.packagerId)) {
        throw error("native_scene_busy", 429);
      }
      const base = { version: 1, commandId: `scn_${randomBytes(18).toString("base64url")}`,
        ...Object.fromEntries(scopeKeys.filter(k => !["packagerId", "programRevision"].includes(k)).map(k => [k, current[k]])),
        issuedAt: now, expiresAt: Math.min(now + 4000, current.expiresAt) };
      try {
        command = selection === null ? normalizeNativeSourceSceneQuery({ ...base, type: "source-program-scene-query" }, now)
          : normalizeNativeSourceScene({ ...base, ...selection, type: "source-program-scene" }, now);
      } catch { throw error(selection === null ? "native_scene_unavailable" : "invalid_native_scene_selection", selection === null ? 409 : 400); }
    } catch (cause) { return Promise.reject(cause instanceof NativeSourceSceneError ? cause : error("native_scene_unavailable")); }
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (cause, value) => {
        if (!this.#pending.delete(command.commandId)) return;
        if (timer !== undefined) this.cancel(timer);
        signal?.removeEventListener("abort", abort);
        cause ? reject(cause) : resolve(value);
      };
      const abort = () => finish(error("native_scene_cancelled"));
      const pending = { context: current, command, authorize, finish, lastNow: now };
      this.#pending.set(command.commandId, pending);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        timer = this.schedule(() => {
          try { this.#check(pending); } catch (cause) { finish(cause); }
        }, 100);
        timer?.unref?.();
        this.#check(pending);
        if (signal?.aborted) { abort(); return; }
        if (!this.send(current.socket, command)) finish(error("native_scene_delivery_failed", 503));
      } catch (cause) { finish(cause instanceof NativeSourceSceneError ? cause : error("native_scene_delivery_failed", 503)); }
    });
  }

  #check(pending) {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < pending.lastNow || now >= pending.command.expiresAt) {
      throw error("native_scene_expired", 504);
    }
    pending.lastNow = now;
    let context;
    try { context = pending.authorize(now); } catch { throw error("native_scene_authority_changed"); }
    if (!sameNativeSceneContext(context, pending.context) || context.expiresAt <= now) throw error("native_scene_authority_changed");
    return now;
  }

  acknowledge(socket, message) {
    const pending = this.#pending.get(message.commandId);
    // Late duplicates and another authenticated agent cannot disturb this operation.
    if (!pending || pending.context.socket !== socket) return false;
    try {
      const now = this.#check(pending), request = pending.command;
      const result = request.type === "source-program-scene-query" ? normalizeNativeSourceSceneState(message, request, now)
        : message.type === "source-program-scene-applied" ? normalizeNativeSourceSceneReceipt(message, request, now)
          : normalizeNativeSourceSceneRejection(message, request, now);
      pending.finish(null, result);
    } catch (cause) {
      pending.finish(cause instanceof NativeSourceSceneError ? cause : error("native_scene_reply_invalid"));
    }
    return true;
  }

  disconnect(socket) {
    for (const pending of this.#pending.values()) if (pending.context.socket === socket) pending.finish(error("native_scene_disconnected", 503));
  }
  destroy() {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.finish(error("native_scene_cancelled"));
  }
}
