import os from "node:os";
import fs from "node:fs";
import { BROADCAST_PROGRAM_STATES } from "./broadcast-program-model.js";
import { BROADCAST_TRANSITIONS } from "./broadcast-program-transitions.js";

const sample = (metric, value, labels = {}) => ({ metric, value, labels });
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function programMetricSamples(runtime) {
  if (typeof runtime?.programStateCounts !== "function") return [];
  const counts = runtime.programStateCounts();
  if (!exact(counts, BROADCAST_PROGRAM_STATES)
    || !BROADCAST_PROGRAM_STATES.every(state => Number.isSafeInteger(counts[state]) && counts[state] >= 0 && counts[state] <= 10_000)
    || Object.values(counts).reduce((sum, count) => sum + count, 0) > 10_000) throw new Error("invalid_metric_counts");
  return BROADCAST_PROGRAM_STATES.map(state => sample("broadcast_control_programs", counts[state], { state }));
}

export function hlsMetricSamples(proxy) {
  if (typeof proxy?.trafficCounts !== "function") return [];
  const counts = proxy.trafficCounts();
  const fields = ["activeRequests", "activeSessions", "bodyBytes", "completed", "cancelled", "failed"];
  if (!exact(counts, fields) || !fields.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    || counts.activeRequests > 10_000 || counts.activeSessions > counts.activeRequests) throw new Error("invalid_hls_metric_counts");
  return [sample("broadcast_hls_proxy_active_requests", counts.activeRequests),
    sample("broadcast_hls_proxy_active_sessions", counts.activeSessions),
    sample("broadcast_hls_proxy_body_bytes_total", counts.bodyBytes),
    ...["completed", "cancelled", "failed"].map(outcome => sample("broadcast_hls_proxy_requests_total", counts[outcome], { outcome }))];
}

const NATIVE_RESOURCE_METRICS = Object.freeze({
  cpuUnits: "broadcast_native_planning_cpu_units",
  memoryMiB: "broadcast_native_planning_memory_mib",
  encoderSlots: "broadcast_native_planning_encoder_slots",
  gpuSlots: "broadcast_native_planning_gpu_slots",
  egressBitsPerSecond: "broadcast_native_planning_egress_bits_per_second",
});

export function nativeResourceMetricSamples(assignments, now) {
  if (typeof assignments?.resourceCounts !== "function") return [];
  const counts = assignments.resourceCounts(now), fields = Object.keys(NATIVE_RESOURCE_METRICS);
  if (!exact(counts, ["used", "limits"]) || !["used", "limits"].every(group => exact(counts[group], fields)
    && fields.every(field => Number.isSafeInteger(counts[group][field]) && counts[group][field] >= 0
      && (group !== "limits" || counts[group][field] <= 1_000_000_000)))) {
    throw new Error("invalid_native_resource_metric_counts");
  }
  return Object.entries(NATIVE_RESOURCE_METRICS).flatMap(([field, metric]) => [
    sample(metric, counts.used[field], { kind: "reserved" }), sample(metric, counts.limits[field], { kind: "limit" }),
  ]);
}

// Windowed durations already aggregated by the runtime: one histogram
// observation each, no program identity, at most 256 values per sample.
export function transitionMetricSamples(runtime, now) {
  if (typeof runtime?.transitionSamples !== "function") return [];
  const values = runtime.transitionSamples(now);
  if (!Array.isArray(values) || values.length > 256 || !values.every(v => exact(v, ["transition", "seconds"])
    && BROADCAST_TRANSITIONS.includes(v.transition) && Number.isFinite(v.seconds) && v.seconds >= 0 && v.seconds <= 3600)) {
    throw new Error("invalid_transition_metric_samples");
  }
  return values.map(v => sample("broadcast_program_transition_seconds", v.seconds, { transition: v.transition }));
}

const ratio = value => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NaN;
export function hostResourceCounts(root = process.cwd(), host = { loadavg: os.loadavg, cpus: os.cpus, freemem: os.freemem, totalmem: os.totalmem, statfs: fs.statfsSync }) {
  const cores = host.cpus().length, total = host.totalmem();
  const stats = host.statfs(root);
  return Object.freeze({
    cpu: ratio(cores > 0 ? host.loadavg()[0] / cores : NaN),
    ram: ratio(total > 0 ? 1 - host.freemem() / total : NaN),
    disk: ratio(stats.blocks > 0 ? 1 - stats.bavail / stats.blocks : NaN),
  });
}

// Control-plane host only: utilization ratios of this process' host, never
// paths, mount names, byte totals or other hosts' numbers.
const QUOTA_SCOPES = Object.freeze(["deployment", "gateway", "tenant", "principal"]);
export function quotaMetricSamples(runtime) {
  if (typeof runtime?.programQuotaCounts !== "function") return [];
  const counts = runtime.programQuotaCounts();
  if (!exact(counts, ["programs"]) || !exact(counts.programs, QUOTA_SCOPES)) throw new Error("invalid_quota_metric_counts");
  return QUOTA_SCOPES.map(scope => {
    const row = counts.programs[scope];
    if (!exact(row, ["used", "limit"]) || !Number.isSafeInteger(row.used) || row.used < 0 || row.used > 20_000
      || !Number.isSafeInteger(row.limit) || row.limit < 1 || row.limit > 10_000) {
      throw new Error("invalid_quota_metric_counts");
    }
    return sample("broadcast_quota_ratio", Math.min(1, row.used / row.limit), { scope, resource: "programs" });
  });
}

const WHIP_SESSION_STATES = Object.freeze(["opening", "active", "closing", "failed"]);
export function whipMetricSamples(runtime) {
  if (typeof runtime?.whipSessionCounts !== "function") return [];
  const counts = runtime.whipSessionCounts();
  if (!exact(counts, WHIP_SESSION_STATES)
    || WHIP_SESSION_STATES.some((state) => !Number.isSafeInteger(counts[state]) || counts[state] < 0 || counts[state] > 10_000)
    || Object.values(counts).reduce((sum, count) => sum + count, 0) > 10_000) {
    throw new Error("invalid_whip_metric_counts");
  }
  return WHIP_SESSION_STATES.map((state) => sample("broadcast_whip_sessions", counts[state], { state }));
}

const VIEWER_CLASSES = Object.freeze(["origin-small", "cdn-medium", "cdn-large"]);
export function viewerMetricSamples(sessions) {
  if (sessions == null || typeof sessions.size !== "number") return [];
  const size = sessions.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > 10_000) throw new Error("invalid_viewer_metric_counts");
  const klass = size <= 20 ? "origin-small" : size <= 500 ? "cdn-medium" : "cdn-large";
  return VIEWER_CLASSES.map((name) => sample("broadcast_viewers", name === klass ? size : 0, { class: name }));
}

export function hostResourceMetricSamples(host) {
  if (typeof host?.resourceCounts !== "function") return [];
  const counts = host.resourceCounts();
  if (!exact(counts, ["cpu", "ram", "disk"]) || !["cpu", "ram", "disk"].every(key => Number.isFinite(counts[key]) && counts[key] >= 0 && counts[key] <= 1)) {
    throw new Error("invalid_host_resource_counts");
  }
  return ["cpu", "ram", "disk"].map(resource => sample("broadcast_resource_utilization_ratio", counts[resource], { component: "control-plane", resource }));
}
