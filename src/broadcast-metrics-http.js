import { AuthenticationError, bearerToken } from "./oidc-verifier.js";

const headers = Object.freeze({
  "content-type": "text/plain; version=0.0.4; charset=utf-8",
  "cache-control": "no-store",
  vary: "Authorization, Origin",
  "x-content-type-options": "nosniff",
});
function reply(status, body = "") { return Object.freeze({ status, headers, body }); }

// Deployment-wide budgets, not per-user maps. Untrusted credentials never
// allocate identity state. The separate optional export cannot change policy.
export class BroadcastMetricsHttp {
  #config;
  #metrics;
  #verifier;
  #clock;
  #window = null;
  #last = 0;
  #attempts = 0;
  #inflight = 0;
  #closed = false;

  constructor({ config, metrics, verifier, clock = () => performance.now() }) {
    this.#config = config;
    this.#metrics = metrics;
    this.#verifier = verifier;
    this.#clock = clock;
  }

  #acquire() {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < this.#last) return null;
    this.#last = now;
    if (this.#window === null || now - this.#window >= 60_000) {
      this.#window = now;
      this.#attempts = 0;
    }
    if (this.#inflight >= 2 || this.#attempts >= 60) return null;
    this.#attempts++;
    this.#inflight++;
    let released = false;
    return () => { if (!released) { released = true; this.#inflight--; } };
  }

  async read(request, url) {
    const config = this.#config;
    if (this.#closed || config.broadcastMetricsEnabled !== true || config.authMode !== "required"
      || !config.publicOrigin?.startsWith("https://") || request.method !== "GET"
      || url.pathname !== "/api/broadcasts/metrics" || url.search
      || (request.headers.origin !== undefined && request.headers.origin !== config.publicOrigin)) {
      return reply(404);
    }
    const release = this.#acquire();
    if (!release) return reply(429, "broadcast_metrics_temporarily_unavailable\n");
    try {
      const header = request.headers.authorization;
      if (typeof header !== "string" || header.length > 8192) return reply(401);
      if (typeof this.#verifier?.verifyBroadcastOperator !== "function") return reply(503);
      const identity = await this.#verifier.verifyBroadcastOperator(bearerToken(header));
      if (!identity || typeof identity.subject !== "string" || !identity.subject
        || identity.issuer !== config.oidcIssuer || identity.audience !== config.oidcAudience
        || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= Date.now()) return reply(401);
      if (this.#closed) return reply(503);
      const body = this.#metrics.prometheus();
      return body ? reply(200, body) : reply(503, "broadcast_metrics_unavailable\n");
    } catch (error) {
      if (error instanceof AuthenticationError) return reply(error.code === "broadcast_operator_required" ? 403 : 401);
      return reply(503, "broadcast_metrics_unavailable\n");
    } finally { release(); }
  }

  destroy() {
    this.#closed = true;
    this.#metrics = this.#verifier = null;
  }
}
