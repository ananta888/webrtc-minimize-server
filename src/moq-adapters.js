import {
  MOQ_PROTOCOL_PINS,
  MoqContractError,
  createMoqNamespace,
  negotiateMoqCapabilities,
  validateMoqContract,
} from "./moq-contracts.js";

const ADAPTER_ID = /^[a-z][a-z0-9-]{2,63}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{2,63}$/;
const PARTICIPANT_REF = /^(gtw|prv)_[A-Za-z0-9_-]{16,64}$/;
const TENANT_ID = /^tn_[A-Za-z0-9_-]{16,64}$/;
const SAFE_RESULT_FIELDS = new Set([
  "sessionRef", "endpointRef", "state", "expiresAt", "adapterId", "transport", "reasonCode",
]);
const SECRET_FIELDS = /token|secret|authorization|credential|private.?key/i;

export class MoqAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "MoqAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new MoqAdapterError(code);
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sanitizeOperationResult(value) {
  exactObject(value, SAFE_RESULT_FIELDS, "unsafe_moq_adapter_result");
  for (const [field, item] of Object.entries(value)) {
    if (SECRET_FIELDS.test(field) || (typeof item === "string" && /bearer\s|[?&](token|key)=/i.test(item))) {
      fail("unsafe_moq_adapter_result");
    }
  }
  if (!/^moqs_[A-Za-z0-9_-]{16,64}$/.test(value.sessionRef || "")
    || !/^moqe_[A-Za-z0-9_-]{16,64}$/.test(value.endpointRef || "")
    || !["opening", "active", "closed"].includes(value.state)
    || !Number.isSafeInteger(value.expiresAt)
    || (value.adapterId !== undefined && !ADAPTER_ID.test(value.adapterId))
    || (value.transport !== undefined && value.transport !== "moq")
    || (value.reasonCode !== undefined && !/^[a-z][a-z0-9_-]{2,63}$/.test(value.reasonCode))) {
    fail("invalid_moq_adapter_result");
  }
  return deepFreeze({ ...value });
}

export function validateMoqTarget(rawUrl, policy) {
  const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const pathPattern = /^\/[A-Za-z0-9._~/-]{1,200}$/;
  exactObject(policy, new Set(["allowedHosts", "allowedPathPrefixes"]), "invalid_moq_target_policy");
  const { allowedHosts, allowedPathPrefixes } = policy;
  if (!Array.isArray(allowedHosts) || allowedHosts.length < 1 || allowedHosts.length > 16
    || !Array.isArray(allowedPathPrefixes) || allowedPathPrefixes.length < 1
    || allowedPathPrefixes.length > 16
    || allowedHosts.some((host) => typeof host !== "string" || !hostPattern.test(host))
    || allowedPathPrefixes.some((path) => typeof path !== "string" || !pathPattern.test(path)
      || path.includes("//") || path.includes(".."))) fail("invalid_moq_target_policy");
  let target;
  try {
    if (typeof rawUrl !== "string") fail("invalid_moq_target");
    target = new URL(rawUrl);
  } catch {
    fail("invalid_moq_target");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash
    || (target.port && target.port !== "443") || target.hostname === "localhost"
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.hostname) || target.hostname.includes(":")) {
    fail("invalid_moq_target");
  }
  const normalizedHosts = allowedHosts.map((host) => String(host).toLowerCase());
  if (!normalizedHosts.includes(target.hostname.toLowerCase())) fail("moq_target_host_denied");
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(target.pathname);
  } catch {
    fail("invalid_moq_target");
  }
  if (decodedPath.includes("..") || decodedPath.includes("//")
    || !allowedPathPrefixes.some((prefix) => decodedPath === prefix || decodedPath.startsWith(`${prefix}/`))) {
    fail("moq_target_path_denied");
  }
  return deepFreeze({ origin: target.origin, pathname: decodedPath });
}

function validateVaultEntry(entry) {
  const fields = new Set([
    "providerId", "environment", "authorizationHeader", "allowedTenantIds", "expiresAt",
    "maxOperationsPerMinute", "revision", "targetUrl", "targetPolicy",
  ]);
  exactObject(entry, fields, "invalid_moq_credential_entry");
  if (!PROVIDER_ID.test(entry.providerId || "")
    || !["staging", "production"].includes(entry.environment)
    || !/^Bearer [\x21-\x7e]{16,2048}$/.test(entry.authorizationHeader || "")
    || !Array.isArray(entry.allowedTenantIds) || entry.allowedTenantIds.length < 1
    || entry.allowedTenantIds.length > 64 || entry.allowedTenantIds.some((id) => !TENANT_ID.test(id))
    || !Number.isSafeInteger(entry.expiresAt) || !Number.isSafeInteger(entry.maxOperationsPerMinute)
    || entry.maxOperationsPerMinute < 1 || entry.maxOperationsPerMinute > 600
    || !Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    fail("invalid_moq_credential_entry");
  }
  const target = validateMoqTarget(entry.targetUrl, entry.targetPolicy);
  return {
    providerId: entry.providerId,
    environment: entry.environment,
    authorizationHeader: Buffer.from(entry.authorizationHeader),
    allowedTenantIds: Object.freeze([...entry.allowedTenantIds]),
    expiresAt: entry.expiresAt,
    maxOperationsPerMinute: entry.maxOperationsPerMinute,
    revision: entry.revision,
    target,
  };
}

export class MoqProviderCredentialVault {
  #entries = new Map();
  #usage = new Map();
  #audit = [];
  #disabled = new Set();
  #clock;
  #consumer;

  constructor(entries, credentialConsumer, clock = Date.now) {
    if (!Array.isArray(entries) || entries.length > 16 || typeof credentialConsumer !== "function"
      || typeof clock !== "function") fail("invalid_moq_credential_vault");
    this.#clock = clock;
    this.#consumer = credentialConsumer;
    for (const raw of entries) {
      const entry = validateVaultEntry(raw);
      if (this.#entries.has(entry.providerId)) fail("duplicate_moq_provider_credential");
      this.#entries.set(entry.providerId, entry);
    }
  }

  async execute(request) {
    exactObject(request, new Set(["providerId", "tenantId", "environment", "action"]),
      "invalid_moq_provider_request");
    const now = this.#clock();
    const entry = this.#entries.get(request.providerId);
    const allowed = entry && !this.#disabled.has(request.providerId)
      && entry.environment === request.environment && entry.expiresAt > now
      && entry.allowedTenantIds.includes(request.tenantId)
      && ["publish", "subscribe", "close"].includes(request.action);
    if (!allowed) {
      this.#record(request, "denied", now);
      fail("moq_provider_access_denied");
    }
    const usageKey = `${request.providerId}:${request.tenantId}`;
    const windowStart = now - (now % 60_000);
    const usage = this.#usage.get(usageKey);
    const count = usage?.windowStart === windowStart ? usage.count : 0;
    if (count >= entry.maxOperationsPerMinute) {
      this.#record(request, "rate-limited", now);
      fail("moq_provider_rate_limited");
    }
    this.#usage.set(usageKey, { windowStart, count: count + 1 });
    try {
      const result = await this.#consumer({
        authorizationHeader: entry.authorizationHeader.toString("utf8"),
        target: entry.target,
        action: request.action,
      });
      const safe = sanitizeOperationResult(result);
      this.#record(request, "allowed", now);
      return safe;
    } catch (error) {
      this.#record(request, "failed", now);
      if (error instanceof MoqAdapterError) throw error;
      fail("moq_provider_operation_failed");
    }
  }

  rotate(providerId, expectedRevision, replacement) {
    const current = this.#entries.get(providerId);
    if (!current || current.revision !== expectedRevision) fail("stale_moq_credential_revision");
    const next = validateVaultEntry({ ...replacement, providerId, revision: expectedRevision + 1 });
    current.authorizationHeader.fill(0);
    this.#entries.set(providerId, next);
    for (const key of this.#usage.keys()) {
      if (key.startsWith(`${providerId}:`)) this.#usage.delete(key);
    }
    this.#record({ providerId, tenantId: null, environment: next.environment, action: "rotate" }, "allowed", this.#clock());
  }

  setKillSwitch(providerId, disabled) {
    if (!this.#entries.has(providerId) || typeof disabled !== "boolean") fail("invalid_moq_kill_switch");
    if (disabled) this.#disabled.add(providerId);
    else this.#disabled.delete(providerId);
    this.#record({ providerId, tenantId: null, environment: null, action: "kill-switch" },
      disabled ? "disabled" : "enabled", this.#clock());
  }

  auditSnapshot() {
    return deepFreeze(this.#audit.map((entry) => ({ ...entry })));
  }

  destroy() {
    for (const entry of this.#entries.values()) entry.authorizationHeader.fill(0);
    this.#entries.clear();
    this.#usage.clear();
    this.#disabled.clear();
  }

  #record(request, outcome, observedAt) {
    this.#audit.push({
      providerId: typeof request.providerId === "string" ? request.providerId : "invalid",
      tenantId: TENANT_ID.test(request.tenantId || "") ? request.tenantId : null,
      environment: ["staging", "production"].includes(request.environment) ? request.environment : null,
      action: ["publish", "subscribe", "close", "rotate", "kill-switch"].includes(request.action)
        ? request.action : "invalid",
      outcome,
      observedAt,
    });
    if (this.#audit.length > 256) this.#audit.splice(0, this.#audit.length - 256);
  }
}

class DeclaredMoqAdapter {
  constructor(definition, clock = Date.now) {
    if (!definition || !ADAPTER_ID.test(definition.adapterId || "")
      || !["gateway", "provider"].includes(definition.participantKind)
      || !PARTICIPANT_REF.test(definition.participantRef || "") || typeof clock !== "function") {
      fail("invalid_moq_adapter_definition");
    }
    this.adapterId = definition.adapterId;
    this.adapterKind = definition.adapterKind;
    this.participantKind = definition.participantKind;
    this.participantRef = definition.participantRef;
    this.enabled = definition.enabled;
    this.transportVersions = Object.freeze([...definition.transportVersions]);
    this.locVersions = Object.freeze([...definition.locVersions]);
    this.webTransportVersions = Object.freeze([...definition.webTransportVersions]);
    this.secureObjectVersions = Object.freeze([...definition.secureObjectVersions]);
    this.codecs = Object.freeze([...definition.codecs]);
    this.fallbackProtocols = Object.freeze([...definition.fallbackProtocols]);
    this.extensions = Object.freeze([...definition.extensions]);
    this.unavailableReason = definition.unavailableReason;
    this.clock = clock;
  }

  capability(scope) {
    const now = this.clock();
    return validateMoqContract({
      contractVersion: 1,
      type: "moq-capability",
      ...scope,
      participantKind: this.participantKind,
      participantRef: this.participantRef,
      enabled: this.enabled,
      transportVersions: this.transportVersions,
      locVersions: this.locVersions,
      webTransportVersions: this.webTransportVersions,
      secureObjectVersions: this.secureObjectVersions,
      codecs: this.codecs,
      fallbackProtocols: this.fallbackProtocols,
      extensions: this.extensions,
      maxCatalogBytes: 65_536,
      maxObjectBytes: 1_048_576,
      observedAt: now,
      expiresAt: now + 30_000,
    }, scope, now);
  }

  async publish() { fail(this.unavailableReason || "moq_adapter_unavailable"); }
  async subscribe() { fail(this.unavailableReason || "moq_adapter_unavailable"); }
  async close() { return undefined; }
}

export function createMediaMtxMoqAdapter(clock = Date.now) {
  return new DeclaredMoqAdapter({
    adapterId: "mediamtx-moq",
    adapterKind: "mediamtx-moq",
    participantKind: "gateway",
    participantRef: "gtw_mediamtxxxxxxxxx",
    enabled: false,
    transportVersions: ["draft-ietf-moq-transport-19"],
    locVersions: [MOQ_PROTOCOL_PINS.loc],
    webTransportVersions: [MOQ_PROTOCOL_PINS.webTransport],
    secureObjectVersions: [],
    codecs: ["opus", "aac", "vp8", "vp9", "h264", "av1"],
    fallbackProtocols: ["ll-hls", "hls"],
    extensions: ["loc-header-v04"],
    unavailableReason: "mediamtx_moq_draft_mismatch",
  }, clock);
}

export function createCloudflareMoqAdapter(clock = Date.now) {
  return new DeclaredMoqAdapter({
    adapterId: "cloudflare-moq",
    adapterKind: "cloudflare-moq",
    participantKind: "provider",
    participantRef: "prv_cloudflarexxxxxxx",
    enabled: false,
    transportVersions: ["draft-ietf-moq-transport-14", "draft-ietf-moq-transport-16"],
    locVersions: ["draft-ietf-moq-loc-03"],
    webTransportVersions: [MOQ_PROTOCOL_PINS.webTransport],
    secureObjectVersions: [],
    codecs: ["opus", "h264"],
    fallbackProtocols: ["ll-hls", "hls"],
    extensions: [],
    unavailableReason: "cloudflare_moq_draft_mismatch",
  }, clock);
}

export function createTestMoqAdapter({ participantKind, participantRef, adapterId, transport }, clock = Date.now) {
  if (process.env.NODE_ENV !== "test") fail("test_moq_adapter_forbidden");
  const sessions = new Set();
  const adapter = new DeclaredMoqAdapter({
    adapterId,
    adapterKind: "test-only",
    participantKind,
    participantRef,
    enabled: true,
    transportVersions: [MOQ_PROTOCOL_PINS.transport],
    locVersions: [MOQ_PROTOCOL_PINS.loc],
    webTransportVersions: [MOQ_PROTOCOL_PINS.webTransport],
    secureObjectVersions: [],
    codecs: ["h264", "aac"],
    fallbackProtocols: ["ll-hls", "hls"],
    extensions: ["loc-header-v04"],
  }, clock);
  adapter.publish = async (request) => {
    const result = sanitizeOperationResult(await transport("publish", request));
    sessions.add(result.sessionRef);
    return result;
  };
  adapter.subscribe = async (request) => {
    const result = sanitizeOperationResult(await transport("subscribe", request));
    sessions.add(result.sessionRef);
    return result;
  };
  adapter.close = async (sessionRef) => {
    if (!sessions.delete(sessionRef)) return false;
    await transport("close", { sessionRef });
    return true;
  };
  return adapter;
}

export class MoqAdapterRegistry {
  #adapters = new Map();

  constructor(adapters) {
    if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 16) {
      fail("invalid_moq_adapter_inventory");
    }
    for (const adapter of adapters) {
      if (!adapter || !ADAPTER_ID.test(adapter.adapterId || "") || this.#adapters.has(adapter.adapterId)
        || typeof adapter.capability !== "function" || typeof adapter.publish !== "function"
        || typeof adapter.subscribe !== "function" || typeof adapter.close !== "function") {
        fail("invalid_moq_adapter_inventory");
      }
      this.#adapters.set(adapter.adapterId, adapter);
    }
  }

  list(scope) {
    return deepFreeze([...this.#adapters.values()]
      .map((adapter) => ({ adapterId: adapter.adapterId, adapterKind: adapter.adapterKind, capability: adapter.capability(scope) }))
      .sort((left, right) => left.adapterId.localeCompare(right.adapterId)));
  }

  negotiate({ browserCapability, gatewayAdapterId, providerAdapterId, policy, scope }, now = Date.now()) {
    const gateway = this.#adapters.get(gatewayAdapterId);
    const provider = this.#adapters.get(providerAdapterId);
    if (!gateway || gateway.participantKind !== "gateway"
      || !provider || provider.participantKind !== "provider") fail("moq_adapter_unavailable");
    return negotiateMoqCapabilities([
      browserCapability,
      gateway.capability(scope),
      provider.capability(scope),
    ], policy, scope, now);
  }

  require(adapterId) {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) fail("moq_adapter_unavailable");
    return adapter;
  }
}

export function assertMoqScope(scope) {
  try {
    return createMoqNamespace(scope);
  } catch (error) {
    if (error instanceof MoqContractError) fail(error.code);
    throw error;
  }
}
