const METRIC = /^[a-z][a-z0-9_]{2,95}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,31}$/;
const HISTOGRAM_BOUNDS = Object.freeze([0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 30, 60]);
const COMPONENTS = Object.freeze([
  "control-plane", "trusted-packager", "media-gateway", "origin-cdn", "moq-adapter",
]);
const COMPONENT_STATUS = new Set(["disabled", "healthy", "degraded", "unavailable"]);

const DEFINITIONS = Object.freeze({
  broadcast_program_state: { type: "gauge", labels: { state: ["idle", "starting", "live", "degraded", "stopping", "stopped", "failed"], profile: ["origin", "cdn"] } },
  broadcast_program_transition_seconds: { type: "histogram", labels: { transition: ["start", "stop", "handoff", "source-change"] } },
  broadcast_whip_sessions: { type: "gauge", labels: { state: ["opening", "active", "closing", "failed"] } },
  broadcast_ingest_bits_per_second: { type: "gauge", labels: { media: ["audio", "video", "screen"] } },
  broadcast_egress_bits_per_second: { type: "gauge", labels: { delivery: ["origin", "cdn", "moq"] } },
  broadcast_frames_total: { type: "counter", labels: { outcome: ["encoded", "keyframe", "dropped"], media: ["video", "screen"] } },
  broadcast_encoder_seconds_total: { type: "counter", labels: { rendition: ["low", "medium", "high"] } },
  broadcast_delivery_objects_total: { type: "counter", labels: { object: ["segment", "part"], outcome: ["created", "dropped", "failed"] } },
  broadcast_viewers: { type: "gauge", labels: { class: ["origin-small", "cdn-medium", "cdn-large"] } },
  broadcast_player_start_seconds: { type: "histogram", labels: { delivery: ["origin", "cdn", "moq"] } },
  broadcast_end_to_glass_seconds: { type: "histogram", labels: { delivery: ["origin", "cdn", "moq"] } },
  broadcast_rebuffer_ratio: { type: "gauge", labels: { delivery: ["origin", "cdn", "moq"] } },
  broadcast_av_sync_offset_seconds: { type: "histogram", labels: { direction: ["audio-leading", "video-leading"] } },
  broadcast_caption_delay_seconds: { type: "histogram", labels: { source: ["microphone", "screen-audio"] } },
  broadcast_resource_utilization_ratio: { type: "gauge", labels: { component: COMPONENTS, resource: ["cpu", "ram", "disk"] } },
  broadcast_quota_ratio: { type: "gauge", labels: { scope: ["deployment", "tenant", "principal", "gateway"], resource: ["programs", "viewers", "egress", "encoders", "runtime", "cost"] } },
  broadcast_failovers_total: { type: "counter", labels: { failure: ["packager", "gateway", "host", "network", "provider"], outcome: ["recovered", "stopped", "failed"] } },
  broadcast_error_budget_remaining_ratio: { type: "gauge", labels: { profile: ["origin", "cdn"] } },
});

export const BROADCAST_METRIC_DEFINITIONS = DEFINITIONS;

export class BroadcastObservabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastObservabilityError";
    this.code = code;
  }
}

function fail(code) { throw new BroadcastObservabilityError(code); }

function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size && Object.keys(value).every((field) => fields.has(field));
}

function normalizeLabels(definition, labels) {
  const expected = new Set(Object.keys(definition.labels));
  if (!exact(labels, expected)) fail("invalid_broadcast_metric_labels");
  const normalized = {};
  for (const [name, allowed] of Object.entries(definition.labels)) {
    if (!allowed.includes(labels[name])) fail("invalid_broadcast_metric_labels");
    normalized[name] = labels[name];
  }
  return Object.freeze(normalized);
}

function seriesKey(metric, labels) {
  return `${metric}\0${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join("\0")}`;
}

function prometheusLabels(labels) {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${value}"`).join(",")}}` : "";
}

export class BroadcastMetricRegistry {
  #series = new Map();
  #maximumSeries;

  constructor({ maximumSeries = 512 } = {}) {
    if (!Number.isSafeInteger(maximumSeries) || maximumSeries < 32 || maximumSeries > 4_096) {
      fail("invalid_broadcast_metric_registry_configuration");
    }
    this.#maximumSeries = maximumSeries;
  }

  observe(event) {
    if (!exact(event, new Set(["metric", "value", "labels", "observedAt"]))
      || !METRIC.test(event.metric || "") || !Number.isFinite(event.value) || event.value < 0
      || !Number.isSafeInteger(event.observedAt) || event.observedAt < 0) fail("invalid_broadcast_metric");
    const definition = DEFINITIONS[event.metric];
    if (!definition) fail("unknown_broadcast_metric");
    const labels = normalizeLabels(definition, event.labels);
    const key = seriesKey(event.metric, labels);
    let series = this.#series.get(key);
    if (!series) {
      if (this.#series.size >= this.#maximumSeries) fail("broadcast_metric_cardinality_exhausted");
      series = definition.type === "histogram"
        ? { metric: event.metric, type: definition.type, labels, count: 0, sum: 0, buckets: HISTOGRAM_BOUNDS.map(() => 0), observedAt: 0 }
        : { metric: event.metric, type: definition.type, labels, value: 0, observedAt: 0 };
      this.#series.set(key, series);
    }
    if (event.observedAt < series.observedAt) fail("stale_broadcast_metric");
    series.observedAt = event.observedAt;
    if (definition.type === "gauge") series.value = event.value;
    else if (definition.type === "counter") series.value += event.value;
    else {
      series.count += 1;
      series.sum += event.value;
      HISTOGRAM_BOUNDS.forEach((bound, index) => { if (event.value <= bound) series.buckets[index] += 1; });
    }
  }

  snapshot() {
    return Object.freeze([...this.#series.values()].map((series) => Object.freeze({
      ...series,
      ...(series.buckets ? { buckets: Object.freeze([...series.buckets]) } : {}),
    })));
  }

  prometheus() {
    const lines = [];
    for (const series of this.snapshot()) {
      const labels = prometheusLabels(series.labels);
      if (series.type !== "histogram") {
        lines.push(`${series.metric}${labels} ${series.value}`);
        continue;
      }
      HISTOGRAM_BOUNDS.forEach((bound, index) => {
        lines.push(`${series.metric}_bucket${prometheusLabels({ ...series.labels, le: String(bound) })} ${series.buckets[index]}`);
      });
      lines.push(`${series.metric}_bucket${prometheusLabels({ ...series.labels, le: "+Inf" })} ${series.count}`);
      lines.push(`${series.metric}_sum${labels} ${series.sum}`);
      lines.push(`${series.metric}_count${labels} ${series.count}`);
    }
    return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }

  purgeBefore(cutoff) {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) fail("invalid_broadcast_metric_cutoff");
    for (const [key, series] of this.#series) if (series.observedAt < cutoff) this.#series.delete(key);
  }

  clear() { this.#series.clear(); }
  get size() { return this.#series.size; }
}

export class BroadcastHealthRegistry {
  #states = new Map();
  #staleAfterMs;

  constructor({ staleAfterMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 5_000 || staleAfterMs > 5 * 60_000) {
      fail("invalid_broadcast_health_configuration");
    }
    this.#staleAfterMs = staleAfterMs;
    for (const component of COMPONENTS) this.#states.set(component, Object.freeze({
      component,
      status: component === "control-plane" ? "healthy" : "disabled",
      reasonCode: component === "control-plane" ? "READY" : "NOT_CONFIGURED",
      observedAt: Date.now(),
    }));
  }

  update(value) {
    if (!exact(value, new Set(["component", "status", "reasonCode", "observedAt"]))
      || !COMPONENTS.includes(value.component) || !COMPONENT_STATUS.has(value.status)
      || !REASON.test(value.reasonCode || "") || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
      fail("invalid_broadcast_health_observation");
    }
    const previous = this.#states.get(value.component);
    if (previous && value.observedAt < previous.observedAt) fail("stale_broadcast_health_observation");
    this.#states.set(value.component, Object.freeze({ ...value }));
  }

  snapshot(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) fail("invalid_broadcast_health_time");
    const components = [...this.#states.values()].map((value) => Object.freeze({
      component: value.component,
      status: value.status !== "disabled" && now - value.observedAt > this.#staleAfterMs ? "unavailable" : value.status,
      reasonCode: value.status !== "disabled" && now - value.observedAt > this.#staleAfterMs ? "STALE" : value.reasonCode,
    }));
    const control = components.find(({ component }) => component === "control-plane");
    const requiredBroadcast = components.filter(({ component }) => ["trusted-packager", "media-gateway", "origin-cdn"].includes(component));
    const enabledBroadcast = requiredBroadcast.filter(({ status }) => status !== "disabled");
    const broadcast = enabledBroadcast.length === 0 ? "disabled"
      : enabledBroadcast.every(({ status }) => status === "healthy") ? "ready" : "degraded";
    return Object.freeze({
      status: control?.status === "healthy" ? "ok" : "unavailable",
      controlPlane: control?.status === "healthy" ? "ready" : "unavailable",
      broadcast,
      dependencies: Object.freeze(Object.fromEntries(components
        .filter(({ component }) => component !== "control-plane")
        .map(({ component, status }) => [component, status]))),
    });
  }
}

const ALERT_KEYS = new Set([
  "profile", "startP95Ms", "endToGlassP95Ms", "rebufferRatio", "availability", "captionP95Ms",
  "abortRatio", "cpuRatio", "memoryRatio", "diskRatio", "quotaRatio", "errorBudgetRemainingRatio", "failoverSeconds",
]);

const ALERT_RUNBOOK = Object.freeze({
  BROADCAST_START_SLO: "/docs/runbooks/broadcast-start-latency.md",
  BROADCAST_END_TO_GLASS_SLO: "/docs/runbooks/broadcast-latency.md",
  BROADCAST_REBUFFER_SLO: "/docs/runbooks/broadcast-player.md",
  BROADCAST_AVAILABILITY_SLO: "/docs/runbooks/broadcast-availability.md",
  BROADCAST_CAPTION_SLO: "/docs/runbooks/broadcast-captions.md",
  BROADCAST_ABORT_SLO: "/docs/runbooks/broadcast-availability.md",
  BROADCAST_RESOURCE_PRESSURE: "/docs/runbooks/broadcast-capacity.md",
  BROADCAST_QUOTA_PRESSURE: "/docs/runbooks/broadcast-capacity.md",
  BROADCAST_ERROR_BUDGET_LOW: "/docs/runbooks/broadcast-error-budget.md",
  BROADCAST_FAILOVER_SLOW: "/docs/runbooks/broadcast-failover.md",
});

export function evaluateBroadcastAlerts(input) {
  if (!exact(input, ALERT_KEYS) || !["origin", "cdn"].includes(input.profile)
    || Object.entries(input).some(([key, value]) => key !== "profile" && (!Number.isFinite(value) || value < 0))) {
    fail("invalid_broadcast_alert_input");
  }
  const limits = input.profile === "origin"
    ? { start: 3_000, glass: 5_000, rebuffer: 0.02, availability: 0.99, caption: 4_000, abort: 0.03 }
    : { start: 6_000, glass: 12_000, rebuffer: 0.01, availability: 0.995, caption: 8_000, abort: 0.02 };
  const checks = [
    ["BROADCAST_START_SLO", input.startP95Ms > limits.start, "warning"],
    ["BROADCAST_END_TO_GLASS_SLO", input.endToGlassP95Ms > limits.glass, "critical"],
    ["BROADCAST_REBUFFER_SLO", input.rebufferRatio > limits.rebuffer, "critical"],
    ["BROADCAST_AVAILABILITY_SLO", input.availability < limits.availability, "critical"],
    ["BROADCAST_CAPTION_SLO", input.captionP95Ms > limits.caption, "warning"],
    ["BROADCAST_ABORT_SLO", input.abortRatio > limits.abort, "warning"],
    ["BROADCAST_RESOURCE_PRESSURE", Math.max(input.cpuRatio, input.memoryRatio, input.diskRatio) >= 0.85, "warning"],
    ["BROADCAST_QUOTA_PRESSURE", input.quotaRatio >= 0.8, "warning"],
    ["BROADCAST_ERROR_BUDGET_LOW", input.errorBudgetRemainingRatio <= 0.25, "critical"],
    ["BROADCAST_FAILOVER_SLOW", input.failoverSeconds > 10, "critical"],
  ];
  return Object.freeze(checks.filter(([, active]) => active).map(([code, , severity]) => Object.freeze({
    code, severity, runbook: ALERT_RUNBOOK[code],
  })));
}
