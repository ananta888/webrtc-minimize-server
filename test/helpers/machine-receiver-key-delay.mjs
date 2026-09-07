// Private synthetic fault only. No source bytes, policy or production hooks.
export function installReceiverKeyDelay() {
  const Native = window.Worker;
  if (typeof Native !== "function") throw new Error("test_key_delay_worker_missing");
  const stats = { scheduled: 0, delivered: 0, cancelled: 0, delayMs: 0 };
  window.__receiverKeyDelay = stats;
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      this.delayEnabled = options?.name === "sframe-media";
      this.keyDelays = 0;
      this.pendingKey = null;
    }
    cancelHeldKey() {
      const held = this.pendingKey; this.pendingKey = null;
      if (!held) return;
      clearTimeout(held.timer);
      new Uint8Array(held.message.baseKey).fill(0);
      stats.cancelled++;
    }
    postMessage(message, ...args) {
      const held = this.pendingKey;
      if (held && message?.type === "set-key" && message?.direction === "decrypt"
        && message.contextId === held.message.contextId && message.keyId === held.message.keyId) {
        // Preserve first-key/duplicate semantics while that exact KID is held.
        if (message.baseKey instanceof ArrayBuffer && message.baseKey !== held.message.baseKey) {
          new Uint8Array(message.baseKey).fill(0);
        }
        return;
      }
      if (held && (message?.type === "clear-all" || (message?.contextId === held.message.contextId
        && (message?.type === "clear-context" || (message?.type === "set-key" && message?.direction === "decrypt"))))) {
        this.cancelHeldKey();
      }
      if (!this.delayEnabled || this.keyDelays >= 3 || message?.type !== "set-key" || message?.direction !== "decrypt") {
        return super.postMessage(message, ...args);
      }
      this.keyDelays++;
      if (!(message.baseKey instanceof ArrayBuffer) || message.baseKey.byteLength !== 16) {
        throw new Error("test_key_delay_input_invalid");
      }
      const started = performance.now(), pending = { message, args, timer: null };
      this.pendingKey = pending; stats.scheduled++;
      pending.timer = setTimeout(() => {
        if (this.pendingKey !== pending) return;
        this.pendingKey = null;
        this.delayEnabled = false;
        stats.delivered++; stats.delayMs = Math.round(performance.now() - started);
        super.postMessage(pending.message, ...pending.args);
      }, 2000);
    }
    terminate() {
      this.delayEnabled = false;
      this.cancelHeldKey();
      return super.terminate();
    }
  };
}

export function requireReceiverKeyDelay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "cancelled,delayMs,delivered,scheduled"
    || !Number.isInteger(value.scheduled) || value.scheduled < 1 || value.scheduled > 3
    || value.delivered !== 1 || value.cancelled !== value.scheduled - 1
    || !Number.isInteger(value.delayMs) || value.delayMs < 2000 || value.delayMs >= 4000) {
    const error = new Error("test_receiver_key_delay_not_observed");
    if (value && ["scheduled", "delivered", "cancelled", "delayMs"].every(name =>
      Number.isInteger(value[name]) && value[name] >= 0 && value[name] < 120000)) {
      error.observation = { keyStartup: { scheduled: value.scheduled, delivered: value.delivered,
        cancelled: value.cancelled, delayMs: value.delayMs } };
    }
    throw error;
  }
  return value;
}
