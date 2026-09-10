import { BROADCAST_PROGRAM_STATES } from "./broadcast-program-model.js";

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
