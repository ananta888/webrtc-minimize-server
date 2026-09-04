import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const profile = JSON.parse(readFileSync(new URL("../infra/testing/broadcast-validation-profile.v1.json", import.meta.url)));
const results = JSON.parse(readFileSync(new URL("../infra/testing/broadcast-validation-results.v1.json", import.meta.url)));

test("validation profile fixes room scale but publishes no unsupported viewer maximum", () => {
  assert.equal(profile.version, 1);
  assert.equal(profile.productViewerMaximum, null);
  assert.equal(profile.interactiveMeet.participants, 20);
  assert.ok(profile.originTiers.some(({ viewers }) => viewers === 20));
  assert.ok(profile.cdnTiers.some(({ viewers }) => viewers === null));
});

test("release soak and chaos profile names every mandatory observation", () => {
  assert.ok(profile.soak.releaseDurationMs >= 4 * 60 * 60 * 1000);
  assert.deepEqual(new Set(profile.soak.requiredEvents), new Set([
    "source-switch", "layout-switch", "rendition-switch", "caption-cue", "late-join", "network-fault", "explicit-stop",
  ]));
  for (const measurement of ["memory", "handles", "cpu", "gpu", "disk", "egress", "freeze", "drift", "cleanup"]) {
    assert.ok(profile.soak.requiredMeasurements.includes(measurement));
  }
  for (const scenario of [
    "packager-crash", "gateway-restart", "control-plane-restart", "provider-failure", "dns-failure",
    "tls-failure", "expired-grant", "network-partition", "split-brain-attempt",
  ]) assert.ok(profile.chaosScenarios.includes(scenario));
});

test("local evidence is measured and unavailable external gates stay visibly unavailable", () => {
  const origin = results.originRuns.find(({ profile: id }) => id === "room-scale-20");
  assert.equal(origin.status, "verified-local");
  assert.equal(origin.viewers, 20);
  assert.equal(origin.completedViewers, 20);
  assert.equal(origin.errors, 0);
  assert.ok(origin.p95RequestLatencyMs <= profile.budgets.originP95RequestLatencyMsMax);
  assert.ok(origin.gatewayCpuPercent > 0 && origin.gatewayMemoryMiB > 0);
  assert.deepEqual(results.originRuns.map(({ viewers }) => viewers), [5, 20, 50]);
  assert.equal(results.originRuns.every(({ errors, viewers, completedViewers }) => errors === 0 && viewers === completedViewers), true);
  assert.equal(results.cdnRuns.every(({ status }) => status !== "verified"), true);
  assert.equal(results.soak.status, "not-executed");
  assert.deepEqual(results.nativePackagerRuns.map(({ status }) => status), [
    "verified-local",
    "verified-lan-host",
  ]);
  assert.deepEqual(results.nativePackagerRuns[1].renditions, ["low", "medium", "high"]);
  assert.equal(results.nativePackagerRuns[1].hostPackageInstalled, false);
});

test("quality and cost evidence never invent missing physical measurements or rates", () => {
  assert.ok(results.quality.ssim.all >= profile.budgets.ssimAllMin);
  for (const field of ["screenText", "avSync", "captionSync", "subjectiveSample"]) {
    assert.match(results.quality[field], /^unverified-/);
  }
  assert.equal(Object.values(profile.costInputs).every((value) => value === null), true);
  assert.equal(results.cost.status, "measurement-only-no-price-claim");
  assert.deepEqual(results.cost.measuredProfiles.map(({ viewers }) => viewers), [5, 20, 50]);
  assert.match(results.cost.cdnProvider, /unavailable/);
});
