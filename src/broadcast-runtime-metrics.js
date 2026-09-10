import { BroadcastMetricRegistry } from "./broadcast-observability.js";
import { BROADCAST_PROGRAM_STATES } from "./broadcast-program-model.js";

const SAMPLE_INTERVAL_MS = 15_000;

// In-process pull port. Sampling never mutates the program runtime or accesses
// media, identities, grants, directories, leases or private room membership.
export class BroadcastRuntimeMetrics {
  #runtime;
  #clock;
  #metrics = new BroadcastMetricRegistry();
  #lastAttempt = null;
  #destroyed = false;

  constructor({ runtime, clock = Date.now }) {
    if (typeof clock !== "function") throw new Error("invalid_broadcast_metrics_clock");
    this.#runtime = runtime;
    this.#clock = clock;
  }

  #refresh() {
    if (this.#destroyed) return;
    try {
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_metric_time");
      if (this.#lastAttempt !== null && now < this.#lastAttempt) {
        this.#metrics.clear();
        // Re-anchor the bounded sampling interval without exporting old data.
        this.#lastAttempt = now;
        return;
      }
      if (this.#lastAttempt !== null && now - this.#lastAttempt < SAMPLE_INTERVAL_MS) return;
      this.#lastAttempt = now;
      this.#metrics.clear();
      if (typeof this.#runtime?.programStateCounts !== "function") return;
      const counts = this.#runtime.programStateCounts();
      if (!counts || typeof counts !== "object" || Array.isArray(counts)
        || Object.keys(counts).length !== BROADCAST_PROGRAM_STATES.length
        || !BROADCAST_PROGRAM_STATES.every(state => Object.hasOwn(counts, state)
          && Number.isSafeInteger(counts[state]) && counts[state] >= 0 && counts[state] <= 10_000)
        || Object.values(counts).reduce((sum, count) => sum + count, 0) > 10_000) {
        throw new Error("invalid_metric_counts");
      }
      for (const state of BROADCAST_PROGRAM_STATES) this.#metrics.observe({
        metric: "broadcast_control_programs", labels: { state }, value: counts[state], observedAt: now,
      });
    } catch {
      // Observability must not break media/policy or retain a false last-good
      // state. No exception text (potentially containing private data) is logged.
      this.#metrics.clear();
    }
  }

  snapshot() { this.#refresh(); return this.#metrics.snapshot(); }
  prometheus() { this.#refresh(); return this.#metrics.prometheus(); }
  destroy() {
    this.#destroyed = true;
    this.#metrics.clear();
    this.#runtime = null;
  }
}
