import crypto from "node:crypto";
import { BroadcastHlsBudget, BROADCAST_HLS_BUDGET_DEFAULTS } from "./broadcast-hls-budget.js";

const FIELDS = Object.keys(BROADCAST_HLS_BUDGET_DEFAULTS);
const MAXIMUM = { maximumRequestsPerSecond: 10000, maximumEgressBitsPerSecond: 10000000000,
  egressBurstBytes: 24 * 1024 * 1024 };
const ENV = { maximumRequestsPerSecond: "BROADCAST_HLS_MAX_REQUESTS_PER_SECOND",
  maximumEgressBitsPerSecond: "BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND", egressBurstBytes: "BROADCAST_HLS_EGRESS_BURST_BYTES" };

function limits(value, fallback, minimum) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !FIELDS.includes(k))) {
    throw new TypeError("invalid_broadcast_hls_scoped_budget");
  }
  const result = Object.fromEntries(FIELDS.map(k => [k, value[k] === undefined ? fallback[k] : value[k]]));
  if (FIELDS.some(k => !Number.isSafeInteger(result[k]) || result[k] < minimum || result[k] > MAXIMUM[k])) {
    throw new TypeError("invalid_broadcast_hls_scoped_budget");
  }
  return Object.freeze(result);
}

export function hlsScopedBudgetsFromEnvironment(env) {
  const read = (suffix, fallback, minimum) => Object.freeze(Object.fromEntries(FIELDS.map(field => {
    const name = ENV[field] + suffix, raw = env[name];
    const value = raw === undefined ? fallback[field]
      : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < minimum || value > MAXIMUM[field]) throw new TypeError(`invalid_${name}`);
    return [field, value];
  })));
  const global = read("", BROADCAST_HLS_BUDGET_DEFAULTS, 1);
  return Object.freeze({ tenant: read("_PER_TENANT", global, 0), audience: read("_PER_AUDIENCE", global, 0) });
}

/** Instance-local transport fairness. Scopes are verified grant projections,
 * not IPs, rooms or unique-human claims. Never holds content or bearer tokens. */
export class BroadcastHlsScopedBudget {
  #key = crypto.randomBytes(32);
  #clock;
  #now = 0;
  #last = null;
  #closed = false;
  #global;
  #limits;
  #buckets = new Map();
  #maximumBuckets;

  constructor({ deployment = {}, tenant = {}, audience = {}, clock = () => performance.now(), maximumBuckets = 8192 } = {}) {
    const global = limits(deployment, BROADCAST_HLS_BUDGET_DEFAULTS, 1);
    this.#limits = { tenant: limits(tenant, global, 0), audience: limits(audience, global, 0) };
    if (typeof clock !== "function" || !Number.isSafeInteger(maximumBuckets) || maximumBuckets < 2 || maximumBuckets > 8192) {
      throw new TypeError("invalid_broadcast_hls_scoped_budget");
    }
    this.#clock = clock; this.#maximumBuckets = maximumBuckets;
    this.#global = this.#create(global);
  }

  #create(policy) {
    // Zero is enforced before debit; the underlying positive-rate balance is
    // never allowed to authorize traffic against a zero scoped limit.
    return { policy, balance: new BroadcastHlsBudget({
      ...Object.fromEntries(FIELDS.map(k => [k, Math.max(1, policy[k])])), clock: () => this.#now,
    }) };
  }

  #tick() {
    if (this.#closed) return false;
    let now;
    try { now = this.#clock(); } catch { this.#closed = true; return false; }
    if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || this.#last !== null && now < this.#last) {
      this.#closed = true; return false;
    }
    this.#now = this.#last = now;
    return true;
  }

  forScope(scope) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).length !== 2
      || !Object.keys(scope).every(k => ["tenantId", "audienceRef"].includes(k)) || typeof scope.tenantId !== "string"
      || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(scope.tenantId) || typeof scope.audienceRef !== "string"
      || !/^(sub|pkr)_[A-Za-z0-9_-]{16,64}$/.test(scope.audienceRef)) return null;
    const digest = text => crypto.createHmac("sha256", this.#key).update(text).digest("base64url");
    const keys = [digest(`tenant\0${scope.tenantId}`), digest(`audience\0${scope.tenantId}\0${scope.audienceRef}`)];
    // Handles retain only keys, never bucket objects: eviction cannot give a
    // still-running stream a second independent refill balance.
    return Object.freeze({ request: () => this.#take(keys, "request", 1), bytes: amount => this.#take(keys, "bytes", amount) });
  }

  #take(keys, kind, amount) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !this.#tick()) return false;
    const policies = [this.#limits.tenant, this.#limits.audience];
    if (policies.some(p => kind === "request" ? p.maximumRequestsPerSecond === 0
      : amount > 0 && (p.maximumEgressBitsPerSecond === 0 || p.egressBurstBytes === 0))) return false;
    const missing = keys.filter(key => !this.#buckets.has(key));
    if (this.#buckets.size + missing.length > this.#maximumBuckets) {
      for (const [key, value] of this.#buckets) if (!keys.includes(key) && value.balance.full()) this.#buckets.delete(key);
      if (this.#buckets.size + missing.length > this.#maximumBuckets) return false;
    }
    for (let i = 0; i < keys.length; i++) if (!this.#buckets.has(keys[i])) this.#buckets.set(keys[i], this.#create(policies[i]));
    const entries = [this.#global, ...keys.map(key => this.#buckets.get(key))];
    if (!entries.every(e => kind === "request" ? e.balance.allowsRequest() : e.balance.allowsBytes(amount))) return false;
    // All callbacks below read the same private #now. No external code or
    // asynchronous work runs between availability and the three debits.
    for (const e of entries) if (kind === "request") e.balance.request(); else e.balance.bytes(amount);
    return true;
  }
}
