import crypto from "node:crypto";

export const NATIVE_ENCODER_WINDOW_MS = 60 * 60_000;
export const NATIVE_ENCODER_MINUTES_DEFAULT = 2880; // 48 continuously occupied slots per UTC hour.
export const NATIVE_ENCODER_MINUTES_ENV = Object.freeze({ deployment: "BROADCAST_NATIVE_ENCODER_MINUTES_PER_HOUR",
  tenant: "BROADCAST_NATIVE_ENCODER_MINUTES_PER_HOUR_PER_TENANT",
  principal: "BROADCAST_NATIVE_ENCODER_MINUTES_PER_HOUR_PER_PRINCIPAL" });
const SCOPES = Object.keys(NATIVE_ENCODER_MINUTES_ENV);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function normalizeNativeEncoderMinutes(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !SCOPES.includes(key))) {
    throw new TypeError("invalid_native_encoder_minutes");
  }
  const deployment = value.deployment === undefined ? NATIVE_ENCODER_MINUTES_DEFAULT : value.deployment;
  const limits = { deployment, tenant: value.tenant === undefined ? deployment : value.tenant,
    principal: value.principal === undefined ? deployment : value.principal };
  if (Object.values(limits).some(limit => !integer(limit, 0, 1_000_000_000))) throw new TypeError("invalid_native_encoder_minutes");
  return Object.freeze(limits);
}

export function nativeEncoderMinutesFromEnvironment(env) {
  const limits = {};
  for (const [scope, name] of Object.entries(NATIVE_ENCODER_MINUTES_ENV)) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (!["number", "string"].includes(typeof raw) || typeof raw === "string" && !raw.trim()
      || !integer(Number(raw), 0, 1_000_000_000)) throw new TypeError(`invalid_${name}`);
    limits[scope] = Number(raw);
  }
  return normalizeNativeEncoderMinutes(limits);
}

/** Conservative authorization-time accounting, not actual encode time or billing.
 * Process-local, bounded, fixed UTC hours; no refund and no media/room/program IDs.
 * The assignment registry alone owns the paid-until fence for each writer. */
export class NativeEncoderTimeBudget {
  #limits; #key = crypto.randomBytes(32); #buckets = new Map(); #maximumBuckets;
  #observedAt = 0; #blocked = false;
  constructor(limits, maximumBuckets = 8192) {
    this.#limits = normalizeNativeEncoderMinutes(limits);
    if (!integer(maximumBuckets, 6, 65536)) throw new TypeError("invalid_native_encoder_budget_capacity");
    this.#maximumBuckets = maximumBuckets;
  }
  #observe(now) {
    if (!integer(now, 1, Number.MAX_SAFE_INTEGER - 2 * NATIVE_ENCODER_WINDOW_MS) || now < this.#observedAt) this.#blocked = true;
    if (this.#blocked) return false;
    this.#observedAt = now;
    for (const [key, bucket] of this.#buckets) if (bucket.window + NATIVE_ENCODER_WINDOW_MS <= now) this.#buckets.delete(key);
    return true;
  }
  #plan(scope, slots, from, until, now) {
    if (!this.#observe(now) || !scope || typeof scope !== "object" || Array.isArray(scope)
      || Object.keys(scope).length !== 2 || !Object.hasOwn(scope, "tenantId") || !Object.hasOwn(scope, "ownerPrincipal")
      || typeof scope.tenantId !== "string" || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(scope.tenantId)
      || typeof scope.ownerPrincipal !== "string" || !/^[^\u0000-\u001f\u007f]{1,2049}$/.test(scope.ownerPrincipal)
      || !integer(slots, 1, 3) || !integer(from, now, now + 120000) || !integer(until, from, now + 120000)) return null;
    const hashes = ["deployment", ...[scope.tenantId, `${scope.tenantId}\0${scope.ownerPrincipal}`]
      .map(value => crypto.createHmac("sha256", this.#key).update(value).digest("base64url"))];
    const plan = [];
    for (let start = from; start < until;) {
      const window = Math.floor(start / NATIVE_ENCODER_WINDOW_MS) * NATIVE_ENCODER_WINDOW_MS;
      const end = Math.min(until, window + NATIVE_ENCODER_WINDOW_MS), milliseconds = (end - start) * slots;
      SCOPES.forEach((name, i) => {
        const key = `${window}:${name}:${hashes[i]}`;
        plan.push({ key, window, used: (this.#buckets.get(key)?.used || 0) + milliseconds, limit: this.#limits[name] * 60000 });
      });
      start = end;
    }
    if (plan.some(p => p.used > p.limit) || this.#buckets.size + plan.filter(p => !this.#buckets.has(p.key)).length > this.#maximumBuckets) return null;
    return plan;
  }
  allows(scope, slots, from, until, now) { return this.#plan(scope, slots, from, until, now) !== null; }
  reserve(scope, slots, from, until, now) {
    const plan = this.#plan(scope, slots, from, until, now);
    if (!plan) return false;
    for (const { key, window, used } of plan) this.#buckets.set(key, { window, used });
    return true;
  }
  snapshot(now) {
    const valid = this.#observe(now), windowStart = valid ? Math.floor(now / NATIVE_ENCODER_WINDOW_MS) * NATIVE_ENCODER_WINDOW_MS : null;
    return Object.freeze({ windowStart, blocked: !valid,
      authorizedEncoderMilliseconds: valid ? this.#buckets.get(`${windowStart}:deployment:deployment`)?.used || 0 : null,
      limitEncoderMilliseconds: this.#limits.deployment * 60000 });
  }
}
