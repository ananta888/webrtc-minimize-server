import crypto from "node:crypto";

const REF = /^(?:tn|sub|prg)_[A-Za-z0-9_-]{16,64}$/;

export class BroadcastBudgetError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "BroadcastBudgetError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new BroadcastBudgetError(code, status); }

function normalizeLimit(value, name) {
  const fields = new Set(["viewerSessions", "egressBitsPerSecond", "encoderSlots", "encoderMinutes", "programMinutes", "costMicros"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || [...fields].some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)) {
    fail(`invalid_broadcast_${name}_budget`);
  }
  return Object.freeze({ ...value });
}

function add(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));
}

function ratio(value, limit) { return limit === 0 ? (value === 0 ? 0 : Infinity) : value / limit; }

export const DEFAULT_BROADCAST_BUDGET_LIMITS = Object.freeze({
  deployment: Object.freeze({
    viewerSessions: 1_000, egressBitsPerSecond: 1_000_000_000, encoderSlots: 48,
    encoderMinutes: 20_000, programMinutes: 30_000, costMicros: 0,
  }),
  tenant: Object.freeze({
    viewerSessions: 500, egressBitsPerSecond: 500_000_000, encoderSlots: 16,
    encoderMinutes: 10_000, programMinutes: 15_000, costMicros: 0,
  }),
  principal: Object.freeze({
    viewerSessions: 100, egressBitsPerSecond: 100_000_000, encoderSlots: 3,
    encoderMinutes: 1_000, programMinutes: 2_000, costMicros: 0,
  }),
});

export function requestedBroadcastUsage({
  viewerSessions = 20, egressBitsPerSecond = 0, encoderSlots = 1, encoderMinutes = 1, programMinutes = 1,
} = {}) {
  return normalizeLimit({
    viewerSessions, egressBitsPerSecond, encoderSlots, encoderMinutes, programMinutes, costMicros: 0,
  }, "request");
}

export function evaluateLedgerBudget(ledger, input, at) {
  if (!ledger || typeof ledger.usage !== "function") fail("invalid_broadcast_usage_ledger", 500);
  const usage = ledger.usage({ tenantId: input.tenantId, principalRef: input.principalRef, at });
  return evaluateBroadcastBudget({
    tenantId: input.tenantId,
    principalRef: input.principalRef,
    programId: input.programId,
    requested: input.requested,
    usage,
    limits: input.limits || DEFAULT_BROADCAST_BUDGET_LIMITS,
    softLimitRatio: input.softLimitRatio ?? 0.8,
  });
}

export function evaluateBroadcastBudget(input) {
  const fields = new Set(["tenantId", "principalRef", "programId", "requested", "usage", "limits", "softLimitRatio"]);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.size || Object.keys(input).some((field) => !fields.has(field))
    || !REF.test(input.tenantId || "") || !REF.test(input.principalRef || "") || !REF.test(input.programId || "")
    || !Number.isFinite(input.softLimitRatio) || input.softLimitRatio < 0.5 || input.softLimitRatio >= 1
    || !input.limits || Object.keys(input.limits).length !== 3
    || Object.keys(input.limits).some((field) => !new Set(["deployment", "tenant", "principal"]).has(field))) {
    fail("invalid_broadcast_budget_request");
  }
  const requested = normalizeLimit(input.requested, "request");
  const scopes = Object.freeze({
    deployment: Object.freeze({ usage: normalizeLimit(input.usage.deployment, "usage"), limit: normalizeLimit(input.limits.deployment, "limit") }),
    tenant: Object.freeze({ usage: normalizeLimit(input.usage.tenant, "usage"), limit: normalizeLimit(input.limits.tenant, "limit") }),
    principal: Object.freeze({ usage: normalizeLimit(input.usage.principal, "usage"), limit: normalizeLimit(input.limits.principal, "limit") }),
  });
  const warnings = [];
  for (const [scope, values] of Object.entries(scopes)) {
    const next = add(values.usage, requested);
    for (const [metric, limit] of Object.entries(values.limit)) {
      const usedRatio = ratio(next[metric], limit);
      if (usedRatio > 1) fail(`broadcast_${scope}_${metric}_budget_exhausted`, 429);
      if (usedRatio >= input.softLimitRatio) warnings.push(`${scope}:${metric}:soft-limit`);
    }
  }
  const viewerClass = requested.viewerSessions <= 20 ? "origin-small"
    : requested.viewerSessions <= 500 ? "cdn-medium" : "cdn-large";
  return Object.freeze({
    admitted: true,
    capacityClass: viewerClass,
    warnings: Object.freeze(warnings.sort()),
    requested,
  });
}

export const BROADCAST_SLOS = Object.freeze({
  "origin-llhls-x86-dev-v1": Object.freeze({
    measurementWindowMinutes: 5,
    startupP95Ms: 3_000,
    endToGlassP95Ms: 5_000,
    rebufferRatioMaximum: 0.02,
    availabilityMinimum: 0.99,
    captionDelayP95Ms: 4_000,
    abortRatioMaximum: 0.03,
    errorBudgetMinutesPer30Days: 432,
    runtimeVerified: false,
  }),
  "cdn-standard-hls-v1": Object.freeze({
    measurementWindowMinutes: 15,
    startupP95Ms: 6_000,
    endToGlassP95Ms: 12_000,
    rebufferRatioMaximum: 0.01,
    availabilityMinimum: 0.995,
    captionDelayP95Ms: 8_000,
    abortRatioMaximum: 0.02,
    errorBudgetMinutesPer30Days: 216,
    runtimeVerified: false,
  }),
});

const USAGE_METRICS = Object.freeze([
  "viewerSessions", "egressBitsPerSecond", "encoderSlots", "encoderMinutes", "programMinutes", "costMicros",
]);

export class BroadcastUsageLedger {
  #key;
  #clock;
  #maximumBuckets;
  #destroyed = false;
  #buckets = new Map();

  constructor({ key, clock = Date.now, maximumBuckets = 168 } = {}) {
    if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 64
      || typeof clock !== "function" || !Number.isSafeInteger(maximumBuckets)
      || maximumBuckets < 1 || maximumBuckets > 744) {
      fail("invalid_broadcast_usage_ledger", 500);
    }
    this.#key = Buffer.from(key);
    this.#clock = clock;
    this.#maximumBuckets = maximumBuckets;
  }

  #digest(scope, id) {
    return crypto.createHmac("sha256", this.#key).update(`${scope}\0${id}`).digest("base64url");
  }

  #hour(at) {
    return Math.floor(at / 3_600_000) * 3_600_000;
  }

  record({ tenantId, principalRef, metric, amount, at = this.#clock() }) {
    if (this.#destroyed) fail("invalid_broadcast_usage_ledger", 500);
    if (!REF.test(tenantId || "") || !REF.test(principalRef || "")
      || !USAGE_METRICS.includes(metric) || !Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000
      || !Number.isSafeInteger(at) || at < 0) fail("invalid_broadcast_usage_record");
    const hour = this.#hour(at);
    this.prune(at);
    let bucket = this.#buckets.get(hour);
    if (!bucket) {
      if (this.#buckets.size >= this.#maximumBuckets) fail("broadcast_usage_ledger_capacity_exhausted", 429);
      bucket = new Map();
      this.#buckets.set(hour, bucket);
    }
    const add = (scope, id) => {
      const digest = this.#digest(scope, id);
      const current = bucket.get(digest) || Object.fromEntries(USAGE_METRICS.map((name) => [name, 0]));
      current[metric] += amount;
      bucket.set(digest, current);
    };
    add("deployment", "all");
    add("tenant", tenantId);
    add("principal", `${tenantId}\0${principalRef}`);
  }

  usage({ tenantId, principalRef, at = this.#clock() }) {
    if (this.#destroyed) fail("invalid_broadcast_usage_ledger", 500);
    if (!REF.test(tenantId || "") || !REF.test(principalRef || "")) fail("invalid_broadcast_usage_query");
    this.prune(at);
    const totals = (scope, id) => {
      const digest = this.#digest(scope, id);
      const sum = Object.fromEntries(USAGE_METRICS.map((name) => [name, 0]));
      for (const bucket of this.#buckets.values()) {
        const row = bucket.get(digest);
        if (row) for (const name of USAGE_METRICS) sum[name] += row[name];
      }
      return Object.freeze({ ...sum });
    };
    return Object.freeze({
      deployment: totals("deployment", "all"),
      tenant: totals("tenant", tenantId),
      principal: totals("principal", `${tenantId}\0${principalRef}`),
    });
  }

  prune(at = this.#clock()) {
    const oldest = this.#hour(at) - (this.#maximumBuckets - 1) * 3_600_000;
    for (const hour of [...this.#buckets.keys()]) if (hour < oldest) this.#buckets.delete(hour);
  }

  destroy() {
    this.#buckets.clear();
    this.#key.fill(0);
    this.#destroyed = true;
  }
}

export class PrivacyPreservingViewerCounter {
  #key;
  #leaseMs;
  #maximumPrograms;
  #programs = new Map();

  constructor({ key, leaseMs = 30_000, maximumPrograms = 1_000 }) {
    if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 64
      || !Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000
      || !Number.isSafeInteger(maximumPrograms) || maximumPrograms < 1) fail("invalid_viewer_counter_configuration", 500);
    this.#key = Buffer.from(key);
    this.#leaseMs = leaseMs;
    this.#maximumPrograms = maximumPrograms;
  }

  #digest(programId, sessionId) {
    if (!REF.test(programId || "") || typeof sessionId !== "string" || sessionId.length < 16 || sessionId.length > 128) {
      fail("invalid_viewer_observation");
    }
    return crypto.createHmac("sha256", this.#key).update(`${programId}\0${sessionId}`).digest("base64url");
  }

  observe(programId, sessionId, now = Date.now()) {
    this.prune(now);
    let sessions = this.#programs.get(programId);
    if (!sessions) {
      if (this.#programs.size >= this.#maximumPrograms) fail("viewer_counter_capacity_exhausted", 429);
      sessions = new Map();
      this.#programs.set(programId, sessions);
    }
    sessions.set(this.#digest(programId, sessionId), now + this.#leaseMs);
    return sessions.size;
  }

  count(programId, now = Date.now()) {
    this.prune(now);
    return this.#programs.get(programId)?.size || 0;
  }

  prune(now = Date.now()) {
    for (const [programId, sessions] of this.#programs) {
      for (const [digest, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(digest);
      if (sessions.size === 0) this.#programs.delete(programId);
    }
  }

  destroy() {
    this.#programs.clear();
    this.#key.fill(0);
  }
}
