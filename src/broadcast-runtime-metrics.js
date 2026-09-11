import { BroadcastMetricRegistry } from "./broadcast-observability.js";
import { programMetricSamples, hlsMetricSamples, nativeResourceMetricSamples, transitionMetricSamples, quotaMetricSamples, hostResourceMetricSamples, whipMetricSamples, viewerMetricSamples } from "./broadcast-metric-samples.js";

const SAMPLE_INTERVAL_MS = 15_000;

// In-process pull port. Sampling never mutates the program runtime or accesses
// media, identities, grants, directories or private room membership. Native
// resource occupancy is read only through an aggregate planning-budget port.
export class BroadcastRuntimeMetrics {
  #runtime;
  #hlsProxy;
  #assignments;
  #host;
  #sessions;
  #clock;
  #metrics = new BroadcastMetricRegistry();
  #lastAttempt = null;
  #destroyed = false;

  constructor({ runtime, hlsProxy, assignments, host, sessions, clock = Date.now }) {
    if (typeof clock !== "function") throw new Error("invalid_broadcast_metrics_clock");
    this.#runtime = runtime;
    this.#hlsProxy = hlsProxy;
    this.#assignments = assignments;
    this.#host = host;
    this.#sessions = sessions;
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
      // Independent sources: absent/bad traffic must not invent zeros or hide
      // a valid program sample. Each group is fully validated before insertion.
      for (const [read, source] of [[programMetricSamples, this.#runtime], [hlsMetricSamples, this.#hlsProxy],
        [nativeResourceMetricSamples, this.#assignments], [transitionMetricSamples, this.#runtime],
        [quotaMetricSamples, this.#runtime], [hostResourceMetricSamples, this.#host],
        [whipMetricSamples, this.#runtime], [viewerMetricSamples, this.#sessions]]) {
        let samples;
        try { samples = read(source, now); } catch { continue; }
        for (const event of samples) this.#metrics.observe({ ...event, observedAt: now });
      }
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
    this.#hlsProxy = null;
    this.#assignments = null;
    this.#host = null;
    this.#sessions = null;
  }
}
