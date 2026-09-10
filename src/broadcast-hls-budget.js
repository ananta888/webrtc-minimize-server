// Process-wide transport budgets, not host-capacity evidence or viewer counts.
// Constant state: no resource/session identifiers, payloads, timers or queues.
export const BROADCAST_HLS_BUDGET_DEFAULTS = Object.freeze({
  maximumRequestsPerSecond: 200,
  maximumEgressBitsPerSecond: 100_000_000,
  egressBurstBytes: 24 * 1024 * 1024,
});

export class BroadcastHlsBudget {
  #clock;
  #last = null;
  #closed = false;
  #requestRate;
  #byteRate;
  #burst;
  #requests;
  #bytes;

  constructor({ maximumRequestsPerSecond = BROADCAST_HLS_BUDGET_DEFAULTS.maximumRequestsPerSecond,
    maximumEgressBitsPerSecond = BROADCAST_HLS_BUDGET_DEFAULTS.maximumEgressBitsPerSecond,
    egressBurstBytes = BROADCAST_HLS_BUDGET_DEFAULTS.egressBurstBytes,
    clock = () => performance.now() } = {}) {
    for (const [value, maximum] of [[maximumRequestsPerSecond, 10_000],
      [maximumEgressBitsPerSecond, 10_000_000_000], [egressBurstBytes, 24 * 1024 * 1024]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new TypeError("invalid_broadcast_hls_budget_configuration");
      }
    }
    if (typeof clock !== "function") throw new TypeError("invalid_broadcast_hls_budget_configuration");
    this.#clock = clock;
    this.#requestRate = this.#requests = maximumRequestsPerSecond;
    this.#byteRate = maximumEgressBitsPerSecond / 8;
    this.#burst = this.#bytes = egressBurstBytes;
  }

  #refill() {
    if (this.#closed) return false;
    let now;
    try { now = this.#clock(); } catch { this.#closed = true; return false; }
    if (!Number.isFinite(now) || now < 0 || this.#last !== null && now < this.#last) {
      this.#closed = true;
      return false;
    }
    const elapsed = this.#last === null ? 0 : (now - this.#last) / 1000;
    this.#last = now;
    this.#requests = Math.min(this.#requestRate, this.#requests + elapsed * this.#requestRate);
    this.#bytes = Math.min(this.#burst, this.#bytes + elapsed * this.#byteRate);
    return true;
  }

  request() {
    if (!this.#refill() || this.#requests < 1) return false;
    this.#requests--;
    return true;
  }

  bytes(amount) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !this.#refill() || amount > this.#bytes) return false;
    this.#bytes -= amount;
    return true;
  }
}
