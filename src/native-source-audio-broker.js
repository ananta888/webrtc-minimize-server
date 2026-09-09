import { randomBytes } from "node:crypto";
import { normalizeNativeSourceAudio, normalizeNativeSourceAudioQuery, normalizeNativeSourceAudioReply } from "./native-source-audio.js";

export class NativeSourceAudioError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const error = (code, status) => new NativeSourceAudioError(code, status);
const scope = ["packagerId", "assignmentId", "programId", "programRevision", "programEpoch", "leaseId", "fencingRevision"];
const positive = value => Number.isSafeInteger(value) && value > 0;
export const sameNativeAudioContext = (a, b) => a && b && a.socket === b.socket && a.generation === b.generation
  && a.member === b.member && scope.every(key => a[key] === b[key]);

/** Correlation and budgets only. The caller must supply fresh authoritative context. */
export class NativeSourceAudioBroker {
  #pending = new Map();
  #closed = false;
  constructor({ send, clock = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
    this.send = send; this.clock = clock; this.schedule = schedule; this.cancel = cancel;
  }

  request(selection, authorize, signal, version = 1) {
    if (this.#closed || signal?.aborted) return Promise.reject(error("native_audio_cancelled"));
    let now, context, command;
    try {
      if (![1, 2].includes(version)) throw error("invalid_native_audio_selection", 400);
      now = this.clock(); context = authorize(now);
      // sourceContext supplies an opaque identity handle, not a wire revision.
      if (!positive(now) || !context?.socket || !context.generation || typeof context.generation !== "object"
        || Array.isArray(context.generation) || !context.member || !positive(context.programRevision)
        || typeof context.packagerId !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(context.packagerId)
        || !positive(context.expiresAt) || context.expiresAt <= now) throw error("native_audio_unavailable");
      context = Object.freeze({ ...context });
      if (this.#pending.size >= 128 || [...this.#pending.values()].some(p => p.context.packagerId === context.packagerId)) throw error("native_audio_busy", 429);
      const keys = ["expectedAudioRevision", "sources", ...(version === 2 ? ["strategy"] : [])];
      if (selection !== null && (!selection || typeof selection !== "object" || Array.isArray(selection)
        || Object.keys(selection).length !== keys.length || Object.keys(selection).some(key => !keys.includes(key)))) throw error("invalid_native_audio_selection", 400);
      const base = { version, commandId: `aud_${randomBytes(18).toString("base64url")}`,
        ...Object.fromEntries(scope.filter(key => !["packagerId", "programRevision"].includes(key)).map(key => [key, context[key]])),
        issuedAt: now, expiresAt: Math.min(now + 4000, context.expiresAt) };
      try {
        command = selection === null ? normalizeNativeSourceAudioQuery({ ...base, type: "source-program-audio-query" }, now)
          : normalizeNativeSourceAudio({ ...base, ...selection, type: "source-program-audio" }, now);
      } catch { throw error(selection === null ? "native_audio_unavailable" : "invalid_native_audio_selection", selection === null ? 409 : 400); }
    } catch (cause) { return Promise.reject(cause instanceof NativeSourceAudioError ? cause : error("native_audio_unavailable")); }
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (cause, reply) => {
        if (!this.#pending.delete(command.commandId)) return;
        if (timer !== undefined) this.cancel(timer);
        signal?.removeEventListener("abort", abort);
        cause ? reject(cause) : resolve(reply);
      };
      const abort = () => finish(error("native_audio_cancelled"));
      const pending = { context, command, authorize, finish, lastNow: now };
      this.#pending.set(command.commandId, pending);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        timer = this.schedule(() => { try { this.#check(pending); } catch (cause) { finish(cause); } }, 100);
        timer?.unref?.();
        if (!this.#pending.has(command.commandId)) { this.cancel(timer); return; }
        this.#check(pending);
        if (signal?.aborted) { abort(); return; }
        if (!this.send(context.socket, command)) finish(error("native_audio_delivery_failed", 503));
      } catch (cause) { finish(cause instanceof NativeSourceAudioError ? cause : error("native_audio_delivery_failed", 503)); }
    });
  }

  #check(pending) {
    const now = this.clock();
    if (!positive(now) || now < pending.lastNow || now >= pending.command.expiresAt) throw error("native_audio_expired", 504);
    pending.lastNow = now;
    let current;
    try { current = pending.authorize(now); } catch { throw error("native_audio_authority_changed"); }
    if (!sameNativeAudioContext(current, pending.context) || !positive(current.expiresAt) || current.expiresAt <= now) throw error("native_audio_authority_changed");
    return now;
  }

  acknowledge(socket, message) {
    const pending = this.#pending.get(message?.commandId);
    if (!pending || pending.context.socket !== socket) return false;
    try { pending.finish(null, normalizeNativeSourceAudioReply(message, pending.command, this.#check(pending))); }
    catch (cause) { pending.finish(cause instanceof NativeSourceAudioError ? cause : error("native_audio_reply_invalid")); }
    return true;
  }

  disconnect(socket) {
    for (const p of this.#pending.values()) if (p.context.socket === socket) p.finish(error("native_audio_disconnected", 503));
  }

  destroy() {
    this.#closed = true;
    for (const p of this.#pending.values()) p.finish(error("native_audio_cancelled"));
  }
}
