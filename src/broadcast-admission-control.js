import crypto from "node:crypto";

const TENANT = /^tn_[A-Za-z0-9_-]{16,64}$/;
const PRINCIPAL = /^sub_[A-Za-z0-9_-]{16,64}$/;
const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const GATEWAY = /^gtw_[A-Za-z0-9_-]{16,64}$/;
const OPERATION = /^op_[A-Za-z0-9_-]{16,64}$/;
const ITEM = /^(?:frm|seg|ctl|cc)_[A-Za-z0-9_-]{12,64}$/;

export const BROADCAST_ADMISSION_DEFAULTS = Object.freeze({
  maxRequestBytes: 32 * 1024,
  maxMessageBytes: 16 * 1024,
  maxActiveProgramsDeployment: 32,
  maxActiveProgramsTenant: 8,
  maxActiveProgramsPrincipal: 3,
  maxActiveProgramsGateway: 16,
  maxSources: 4,
  maxRenditions: 3,
  maxEncoders: 3,
  maxQueueItems: 256,
  maxQueueBytes: 32 * 1024 * 1024,
  maxStorageBytes: 512 * 1024 * 1024,
  maxSegmentWindowSeconds: 30,
  maxViewerSessions: 500,
  maxEgressBitsPerSecond: 1_000_000_000,
  maxRuntimeMs: 4 * 60 * 60_000,
  maxStartsPerWindow: 10,
  startWindowMs: 10 * 60_000,
  maxCatalogEntries: 256,
  maxExpandedBytes: 4 * 1024 * 1024,
  maxInflationRatio: 20,
});

const CONFIG_KEYS = new Set(Object.keys(BROADCAST_ADMISSION_DEFAULTS));
const ADMISSION_KEYS = new Set([
  "operationId", "tenantId", "principalRef", "programId", "gatewayRef", "requestBytes", "messageBytes",
  "sourceCount", "renditionCount", "encoderCount", "queueItems", "queueBytes", "storageBytes",
  "segmentWindowSeconds", "viewerSessions", "egressBitsPerSecond", "runtimeMs", "now",
]);

export class BroadcastAdmissionError extends Error {
  constructor(code, status, publicCode, diagnosticRef) {
    super(code);
    this.name = "BroadcastAdmissionError";
    this.code = code;
    this.status = status;
    this.publicCode = publicCode;
    this.diagnosticRef = diagnosticRef;
  }
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function normalizeConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) throw new TypeError("invalid_broadcast_admission_configuration");
  const config = { ...BROADCAST_ADMISSION_DEFAULTS, ...value };
  if (Object.values(config).some((entry) => !Number.isSafeInteger(entry) || entry < 1)
    || config.maxMessageBytes > config.maxRequestBytes || config.maxQueueItems > 4_096
    || config.maxSources > 20 || config.maxRenditions > 8 || config.maxEncoders > 8
    || config.maxInflationRatio > 100 || config.maxCatalogEntries > 4_096) {
    throw new TypeError("invalid_broadcast_admission_configuration");
  }
  return Object.freeze(config);
}

function digestDemand(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export class BroadcastAdmissionController {
  #config;
  #key;
  #leases = new Map();
  #operations = new Map();
  #startAttempts = new Map();

  constructor({ key, limits } = {}) {
    if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 64) {
      throw new TypeError("invalid_broadcast_admission_configuration");
    }
    this.#key = Buffer.from(key);
    this.#config = normalizeConfig(limits);
  }

  admit(input) {
    if (!exact(input, ADMISSION_KEYS) || !OPERATION.test(input.operationId || "")
      || !TENANT.test(input.tenantId || "") || !PRINCIPAL.test(input.principalRef || "")
      || !PROGRAM.test(input.programId || "") || !GATEWAY.test(input.gatewayRef || "")
      || !Number.isSafeInteger(input.now) || input.now < 0) this.#fail("invalid_request", 400, input);
    const demandFields = [
      "requestBytes", "messageBytes", "sourceCount", "renditionCount", "encoderCount", "queueItems", "queueBytes",
      "storageBytes", "segmentWindowSeconds", "viewerSessions", "egressBitsPerSecond", "runtimeMs",
    ];
    if (demandFields.some((field) => !Number.isSafeInteger(input[field]) || input[field] < 0)) {
      this.#fail("invalid_request", 400, input);
    }
    if (input.requestBytes < 1 || input.messageBytes < 1 || input.sourceCount < 1
      || input.renditionCount < 1 || input.encoderCount < 1 || input.segmentWindowSeconds < 1
      || input.runtimeMs < 1_000) this.#fail("invalid_request", 400, input);
    this.prune(input.now);
    const demand = Object.fromEntries(ADMISSION_KEYS.size ? [...ADMISSION_KEYS]
      .filter((field) => field !== "now").map((field) => [field, input[field]]) : []);
    const demandDigest = digestDemand(demand);
    const replay = this.#operations.get(input.operationId);
    if (replay) {
      if (replay.demandDigest !== demandDigest) this.#fail("operation_replay", 409, input);
      return replay.lease;
    }
    this.#recordStartAttempt(input.principalRef, input.now, input);
    const bounded = [
      ["requestBytes", this.#config.maxRequestBytes], ["messageBytes", this.#config.maxMessageBytes],
      ["sourceCount", this.#config.maxSources], ["renditionCount", this.#config.maxRenditions],
      ["encoderCount", this.#config.maxEncoders], ["queueItems", this.#config.maxQueueItems],
      ["queueBytes", this.#config.maxQueueBytes], ["storageBytes", this.#config.maxStorageBytes],
      ["segmentWindowSeconds", this.#config.maxSegmentWindowSeconds],
      ["viewerSessions", this.#config.maxViewerSessions],
      ["egressBitsPerSecond", this.#config.maxEgressBitsPerSecond], ["runtimeMs", this.#config.maxRuntimeMs],
    ];
    for (const [field, limit] of bounded) if (input[field] > limit) this.#fail(`limit_${field}`, 429, input);
    const active = [...this.#leases.values()];
    const counts = {
      deployment: active.length,
      tenant: active.filter((lease) => lease.tenantId === input.tenantId).length,
      principal: active.filter((lease) => lease.principalRef === input.principalRef).length,
      gateway: active.filter((lease) => lease.gatewayRef === input.gatewayRef).length,
    };
    for (const [scope, maximum] of [
      ["deployment", this.#config.maxActiveProgramsDeployment],
      ["tenant", this.#config.maxActiveProgramsTenant],
      ["principal", this.#config.maxActiveProgramsPrincipal],
      ["gateway", this.#config.maxActiveProgramsGateway],
    ]) if (counts[scope] >= maximum) this.#fail(`active_${scope}`, 429, input);
    const lease = Object.freeze({
      admissionId: `badm_${crypto.randomBytes(18).toString("base64url")}`,
      operationId: input.operationId,
      tenantId: input.tenantId,
      principalRef: input.principalRef,
      programId: input.programId,
      gatewayRef: input.gatewayRef,
      admittedAt: input.now,
      expiresAt: input.now + input.runtimeMs,
      diagnosticRef: this.#diagnostic("admitted", input),
    });
    this.#leases.set(lease.admissionId, lease);
    this.#operations.set(input.operationId, { demandDigest, lease });
    return lease;
  }

  release(admissionId) {
    const lease = this.#leases.get(admissionId);
    if (!lease) return false;
    this.#leases.delete(admissionId);
    this.#operations.delete(lease.operationId);
    return true;
  }

  prune(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) return;
    for (const [id, lease] of this.#leases) if (lease.expiresAt <= now) this.release(id);
    for (const [principal, timestamps] of this.#startAttempts) {
      const retained = timestamps.filter((value) => value > now - this.#config.startWindowMs);
      if (retained.length) this.#startAttempts.set(principal, retained);
      else this.#startAttempts.delete(principal);
    }
  }

  snapshot() {
    return Object.freeze({ activePrograms: this.#leases.size });
  }

  destroy() {
    this.#leases.clear();
    this.#operations.clear();
    this.#startAttempts.clear();
    this.#key.fill(0);
  }

  #recordStartAttempt(principalRef, now, input) {
    const retained = (this.#startAttempts.get(principalRef) || [])
      .filter((value) => value > now - this.#config.startWindowMs);
    if (retained.length >= this.#config.maxStartsPerWindow) this.#fail("start_flapping", 429, input);
    retained.push(now);
    this.#startAttempts.set(principalRef, retained);
  }

  #diagnostic(reason, input) {
    const safeScope = [reason, input?.tenantId || "invalid", input?.principalRef || "invalid", input?.gatewayRef || "invalid"].join("\0");
    return `BCAST-${crypto.createHmac("sha256", this.#key).update(safeScope).digest("hex").slice(0, 12).toUpperCase()}`;
  }

  #fail(reason, status, input) {
    throw new BroadcastAdmissionError(
      `broadcast_admission_${reason}`,
      status,
      status === 429 ? "broadcast_temporarily_unavailable" : "broadcast_request_invalid",
      this.#diagnostic(reason, input),
    );
  }
}

const QUEUE_KINDS = new Set(["control", "caption", "realtime-media", "delivery"]);
const QUEUE_KEYS = new Set(["itemRef", "kind", "bytes", "createdAt"]);

export class BoundedBroadcastQueue {
  #items = [];
  #bytes = 0;
  #overflows = 0;

  constructor({ maximumItems, maximumBytes, maximumAgeMs, stopAfterOverflows = 3 }) {
    if (!integer(maximumItems, 1, 4_096) || !integer(maximumBytes, 1_024, 512 * 1024 * 1024)
      || !integer(maximumAgeMs, 100, 60_000) || !integer(stopAfterOverflows, 1, 20)) {
      throw new TypeError("invalid_broadcast_queue_configuration");
    }
    this.maximumItems = maximumItems;
    this.maximumBytes = maximumBytes;
    this.maximumAgeMs = maximumAgeMs;
    this.stopAfterOverflows = stopAfterOverflows;
  }

  enqueue(item, now = Date.now()) {
    if (!exact(item, QUEUE_KEYS) || !ITEM.test(item.itemRef || "") || !QUEUE_KINDS.has(item.kind)
      || !integer(item.bytes, 1, this.maximumBytes) || !Number.isSafeInteger(item.createdAt)
      || !Number.isSafeInteger(now) || item.createdAt > now || now - item.createdAt > this.maximumAgeMs) {
      return Object.freeze({ accepted: false, action: "reject", reason: "invalid_or_stale" });
    }
    this.prune(now);
    const full = this.#items.length >= this.maximumItems || this.#bytes + item.bytes > this.maximumBytes;
    if (full && (item.kind === "control" || item.kind === "delivery")) {
      this.#overflows += 1;
      return Object.freeze({ accepted: false, action: this.#overflows >= this.stopAfterOverflows ? "stop" : "degrade", reason: "backpressure" });
    }
    let dropped = 0;
    while ((this.#items.length >= this.maximumItems || this.#bytes + item.bytes > this.maximumBytes) && this.#items.length) {
      const removed = this.#items.shift();
      this.#bytes -= removed.bytes;
      dropped += 1;
    }
    if (this.#bytes + item.bytes > this.maximumBytes) {
      this.#overflows += 1;
      return Object.freeze({ accepted: false, action: "degrade", reason: "backpressure" });
    }
    this.#items.push(Object.freeze({ ...item }));
    this.#bytes += item.bytes;
    this.#overflows = 0;
    return Object.freeze({ accepted: true, action: dropped ? "drop-oldest" : "enqueue", dropped });
  }

  dequeue(now = Date.now()) {
    this.prune(now);
    const item = this.#items.shift() || null;
    if (item) this.#bytes -= item.bytes;
    return item;
  }

  prune(now = Date.now()) {
    while (this.#items[0] && now - this.#items[0].createdAt > this.maximumAgeMs) {
      this.#bytes -= this.#items.shift().bytes;
    }
  }

  clear() { this.#items = []; this.#bytes = 0; this.#overflows = 0; }
  snapshot() { return Object.freeze({ items: this.#items.length, bytes: this.#bytes, consecutiveOverflows: this.#overflows }); }
}

const ABUSE_ACTIONS = Object.freeze({
  "playback-probe": Object.freeze({ maximum: 30, windowMs: 60_000 }),
  "credential-attempt": Object.freeze({ maximum: 10, windowMs: 5 * 60_000 }),
  "catalog-read": Object.freeze({ maximum: 60, windowMs: 60_000 }),
  "start-stop": Object.freeze({ maximum: 12, windowMs: 10 * 60_000 }),
  "viewer-heartbeat": Object.freeze({ maximum: 120, windowMs: 60_000 }),
});

export class BroadcastAbuseGuard {
  #key;
  #maximumBuckets;
  #buckets = new Map();

  constructor({ key, maximumBuckets = 4_096 }) {
    if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 64 || !integer(maximumBuckets, 16, 100_000)) {
      throw new TypeError("invalid_broadcast_abuse_guard_configuration");
    }
    this.#key = Buffer.from(key);
    this.#maximumBuckets = maximumBuckets;
  }

  allow({ action, actorRef, now = Date.now() }) {
    const policy = ABUSE_ACTIONS[action];
    if (!policy || typeof actorRef !== "string" || actorRef.length < 8 || actorRef.length > 256
      || /[\u0000-\u001f\u007f]/.test(actorRef) || !Number.isSafeInteger(now)) return false;
    this.prune(now);
    const actorDigest = crypto.createHmac("sha256", this.#key).update(actorRef).digest("base64url");
    const key = `${action}:${actorDigest}`;
    const current = this.#buckets.get(key);
    const bucket = !current || current.windowStart + policy.windowMs <= now
      ? { windowStart: now, count: 0, expiresAt: now + policy.windowMs }
      : current;
    if (bucket.count >= policy.maximum) return false;
    if (!this.#buckets.has(key) && this.#buckets.size >= this.#maximumBuckets) return false;
    bucket.count += 1;
    this.#buckets.set(key, bucket);
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.#buckets) if (bucket.expiresAt <= now) this.#buckets.delete(key);
  }

  destroy() { this.#buckets.clear(); this.#key.fill(0); }
  get size() { return this.#buckets.size; }
}

const PAYLOAD_KEYS = new Set(["wireBytes", "expandedBytes", "catalogEntries"]);

export function assertBroadcastPayloadBudget(input, limits = {}) {
  const config = normalizeConfig(limits);
  if (!exact(input, PAYLOAD_KEYS) || !integer(input.wireBytes, 1, config.maxRequestBytes)
    || !integer(input.expandedBytes, input.wireBytes, config.maxExpandedBytes)
    || input.expandedBytes / input.wireBytes > config.maxInflationRatio
    || !integer(input.catalogEntries, 0, config.maxCatalogEntries)) {
    throw new BroadcastAdmissionError("broadcast_payload_rejected", 413, "broadcast_request_invalid", "BCAST-PAYLOAD");
  }
  return Object.freeze({ ...input });
}
