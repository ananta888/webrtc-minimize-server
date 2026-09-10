// Content-free process totals. Never retain chunks, paths, credentials or IDs.
// An invalid/overflowed measurement becomes unavailable, not a media failure.
export class BroadcastHlsTraffic {
  #values = { bodyBytes: 0, completed: 0, cancelled: 0, failed: 0 };

  #add(key, amount) {
    if (!this.#values) return;
    if (!Object.hasOwn(this.#values, key) || !Number.isSafeInteger(amount) || amount < 0
      || !Number.isSafeInteger(this.#values[key] + amount)) { this.#values = null; return; }
    this.#values[key] += amount;
  }

  bytes(amount) { this.#add("bodyBytes", amount); }
  finished(outcome) {
    if (!["completed", "cancelled", "failed"].includes(outcome)) { this.#values = null; return; }
    this.#add(outcome, 1);
  }
  snapshot(activeRequests, activeSessions) {
    if (!this.#values || !Number.isSafeInteger(activeRequests) || activeRequests < 0 || activeRequests > 10_000
      || !Number.isSafeInteger(activeSessions) || activeSessions < 0 || activeSessions > activeRequests) return null;
    return Object.freeze({ activeRequests, activeSessions, ...this.#values });
  }
}
