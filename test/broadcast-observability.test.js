import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  BROADCAST_METRIC_DEFINITIONS,
  BroadcastHealthRegistry,
  BroadcastMetricRegistry,
  evaluateBroadcastAlerts,
} from "../src/broadcast-observability.js";

test("metric catalog covers the required broadcast signals with closed labels", () => {
  const required = [
    "broadcast_program_state", "broadcast_program_transition_seconds", "broadcast_whip_sessions",
    "broadcast_ingest_bits_per_second", "broadcast_egress_bits_per_second", "broadcast_frames_total",
    "broadcast_encoder_seconds_total", "broadcast_delivery_objects_total", "broadcast_viewers",
    "broadcast_player_start_seconds", "broadcast_end_to_glass_seconds", "broadcast_rebuffer_ratio",
    "broadcast_av_sync_offset_seconds", "broadcast_caption_delay_seconds",
    "broadcast_resource_utilization_ratio", "broadcast_quota_ratio", "broadcast_failovers_total",
    "broadcast_error_budget_remaining_ratio",
  ];
  assert.deepEqual(Object.keys(BROADCAST_METRIC_DEFINITIONS), required);
  const registry = new BroadcastMetricRegistry();
  registry.observe({
    metric: "broadcast_ingest_bits_per_second", value: 1_500_000,
    labels: { media: "video" }, observedAt: 1_000,
  });
  registry.observe({
    metric: "broadcast_frames_total", value: 300,
    labels: { outcome: "encoded", media: "video" }, observedAt: 1_001,
  });
  assert.match(registry.prometheus(), /broadcast_frames_total\{outcome="encoded",media="video"\} 300/);
  assert.throws(() => registry.observe({
    metric: "broadcast_frames_total", value: 1,
    labels: { outcome: "encoded", media: "video", programId: "prg_secret" }, observedAt: 1_002,
  }), /invalid_broadcast_metric_labels/);
});

test("histograms aggregate bounded values without retaining individual observations", () => {
  const registry = new BroadcastMetricRegistry({ maximumSeries: 32 });
  for (const value of [0.2, 0.5, 1.5]) registry.observe({
    metric: "broadcast_player_start_seconds", value, labels: { delivery: "origin" }, observedAt: 1_000,
  });
  const [series] = registry.snapshot();
  assert.equal(series.count, 3);
  assert.equal(series.sum, 2.2);
  assert.equal(Object.hasOwn(series, "observations"), false);
  registry.purgeBefore(1_001);
  assert.equal(registry.size, 0);
});

test("readiness separates meet-critical control from optional broadcast and MoQ dependencies", () => {
  const health = new BroadcastHealthRegistry({ staleAfterMs: 30_000 });
  const now = Date.now();
  health.update({ component: "trusted-packager", status: "healthy", reasonCode: "READY", observedAt: now });
  health.update({ component: "media-gateway", status: "healthy", reasonCode: "READY", observedAt: now });
  health.update({ component: "origin-cdn", status: "healthy", reasonCode: "READY", observedAt: now });
  health.update({ component: "moq-adapter", status: "unavailable", reasonCode: "DRAFT_MISMATCH", observedAt: now });
  assert.deepEqual(health.snapshot(now), {
    status: "ok",
    controlPlane: "ready",
    broadcast: "ready",
    dependencies: {
      "trusted-packager": "healthy", "media-gateway": "healthy", "origin-cdn": "healthy", "moq-adapter": "unavailable",
    },
  });
  health.update({ component: "control-plane", status: "unavailable", reasonCode: "PROCESS_FAILED", observedAt: now + 1 });
  assert.equal(health.snapshot(now + 1).status, "unavailable");
});

test("readiness accepts a healthy native packager and origin without a media gateway", () => {
  const health = new BroadcastHealthRegistry({ staleAfterMs: 30_000 });
  const now = Date.now();
  health.update({ component: "trusted-packager", status: "healthy", reasonCode: "NATIVE_READY", observedAt: now });
  health.update({ component: "origin-cdn", status: "healthy", reasonCode: "NATIVE_ORIGIN_READY", observedAt: now });
  assert.deepEqual(health.snapshot(now), {
    status: "ok",
    controlPlane: "ready",
    broadcast: "ready",
    dependencies: {
      "trusted-packager": "healthy", "media-gateway": "disabled",
      "origin-cdn": "healthy", "moq-adapter": "disabled",
    },
  });
});

test("alert thresholds map to fixed severity and repository runbooks", () => {
  const alerts = evaluateBroadcastAlerts({
    profile: "origin", startP95Ms: 3_500, endToGlassP95Ms: 6_000, rebufferRatio: 0.03,
    availability: 0.98, captionP95Ms: 4_500, abortRatio: 0.04, cpuRatio: 0.9,
    memoryRatio: 0.5, diskRatio: 0.4, quotaRatio: 0.85, errorBudgetRemainingRatio: 0.2,
    failoverSeconds: 12,
  });
  assert.equal(alerts.length, 10);
  assert.ok(alerts.every(({ code, severity, runbook }) => (
    /^BROADCAST_[A-Z_]+$/.test(code) && ["warning", "critical"].includes(severity)
      && /^\/docs\/runbooks\/[a-z-]+\.md$/.test(runbook)
  )));
});

test("synthetic secrets, captions, rooms, SDP, ICE and IPs cannot enter metric labels", () => {
  const registry = new BroadcastMetricRegistry();
  const canaries = [
    "Bearer synthetic-secret-token", "vertraulicher untertitel", "private-room-code",
    "v=0\\r\\na=candidate:1", "203.0.113.42",
  ];
  for (const canary of canaries) assert.throws(() => registry.observe({
    metric: "broadcast_program_state", value: 1,
    labels: { state: "live", profile: canary }, observedAt: 1_000,
  }), /invalid_broadcast_metric_labels/);
  assert.equal(registry.prometheus(), "");
});

test("dashboard keeps bounded retention, private access and resolvable runbooks", () => {
  const dashboard = JSON.parse(readFileSync("infra/observability/broadcast-dashboard.v1.json", "utf8"));
  assert.equal(dashboard.version, 1);
  assert.equal(dashboard.runtime_verified, false);
  assert.equal(dashboard.access_role, "broadcast-operator");
  assert.deepEqual(dashboard.retention, {
    high_resolution_days: 14, aggregate_days: 90, raw_media_or_caption_content: "never",
  });
  const panelMetrics = new Set(dashboard.panels.flatMap(({ metrics }) => metrics));
  assert.deepEqual(panelMetrics, new Set(Object.keys(BROADCAST_METRIC_DEFINITIONS)));
  for (const alert of dashboard.alerts) {
    assert.equal(existsSync(alert.runbook.replace(/^\//, "")), true, alert.runbook);
  }
  assert.doesNotMatch(JSON.stringify(dashboard), /roomId|programId|subject|token|captionText|sdp|iceCandidate|ipAddress/i);
});
