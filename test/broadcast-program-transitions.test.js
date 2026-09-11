import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastProgramTransitions } from "../src/broadcast-program-transitions.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { RoomRegistry } from "../src/room-registry.js";
import { BroadcastRuntimeMetrics } from "../src/broadcast-runtime-metrics.js";
import { transitionMetricSamples, hostResourceMetricSamples, hostResourceCounts, quotaMetricSamples } from "../src/broadcast-metric-samples.js";

const NOW = 1_800_000_000_000, tenant = "tn_aaaaaaaaaaaaaaaa", program = "prg_aaaaaaaaaaaaaaaa";
const srcA = "src_aaaaaaaaaaaaaaaa", srcB = "src_bbbbbbbbbbbbbbbb";
const record = (state, { epoch = 1, pending = false, id = program, sourceIds = [srcA] } = {}) => ({ snapshot: { machine: { scope: { tenantId: tenant, programId: id },
  program: { state, revision: 1, programEpoch: epoch, sourceIds } } }, pendingHandoff: pending ? {} : null });
const seconds = (t, transition, at) => t.samples(at).filter(s => s.transition === transition).map(s => s.seconds);

test("start, stop, handoff and source-change durations are derived from committed transitions only, without identifiers", () => {
  const t = new BroadcastProgramTransitions();
  assert.equal(t.observe(null, record("draft"), NOW), true);
  assert.equal(t.observe(record("draft"), record("preparing"), NOW + 500), true);
  assert.equal(t.observe(record("preparing"), record("live"), NOW + 2500), true);
  assert.deepEqual(seconds(t, "start", NOW + 2500), [2.5]);
  assert.equal(t.observe(record("live"), record("degraded"), NOW + 3000), true);
  assert.equal(t.observe(record("degraded"), record("live"), NOW + 3500), true);
  assert.deepEqual(seconds(t, "start", NOW + 3500), [2.5], "returning to live is not a second start");
  // Real sequence: output-restart moves live -> preparing under the next epoch with the
  // handoff pending; the successor writer clears pending; its output ready returns to live.
  assert.equal(t.observe(record("live"), record("preparing", { epoch: 2, pending: true }), NOW + 4000), true);
  assert.equal(t.observe(record("preparing", { epoch: 2, pending: true }), record("preparing", { epoch: 2 }), NOW + 4200), true);
  assert.deepEqual(seconds(t, "handoff", NOW + 4200), [], "an assigned successor without confirmed output does not complete a handoff");
  assert.equal(t.observe(record("preparing", { epoch: 2 }), record("live", { epoch: 2 }), NOW + 5000), true);
  assert.deepEqual(seconds(t, "handoff", NOW + 5000), [1]);
  assert.deepEqual(seconds(t, "start", NOW + 5000), [2.5], "the successor's first output is not a program start");
  assert.equal(t.observe(record("live", { epoch: 2 }), record("preparing", { epoch: 3, sourceIds: [srcB] }), NOW + 5500), true);
  assert.deepEqual(seconds(t, "source-change", NOW + 5500), [], "preparing after a source-change is not yet complete");
  assert.equal(t.observe(record("preparing", { epoch: 3, sourceIds: [srcB] }), record("live", { epoch: 3, sourceIds: [srcB] }), NOW + 5800), true);
  assert.deepEqual(seconds(t, "source-change", NOW + 5800), [.3]);
  assert.deepEqual(seconds(t, "handoff", NOW + 5800), [1], "a source-change is not a second handoff");
  assert.equal(t.observe(record("live", { epoch: 3, sourceIds: [srcB] }), record("stopping", { epoch: 3, sourceIds: [srcB] }), NOW + 6000), true);
  assert.equal(t.observe(record("stopping", { epoch: 3, sourceIds: [srcB] }), record("stopped", { epoch: 3, sourceIds: [srcB] }), NOW + 6250), true);
  assert.deepEqual(seconds(t, "stop", NOW + 6250), [.25]);
  assert.equal(t.pendingPrograms, 0, "a stopped program keeps no anchor");
  assert.equal(t.observe(record("stopped", { epoch: 3, sourceIds: [srcB] }), record("stopped", { epoch: 3, sourceIds: [srcB] }), NOW + 7000), true);
  assert.deepEqual(seconds(t, "stop", NOW + 7000), [.25], "idempotent stop adds nothing");
  for (const sample of t.samples(NOW + 8000)) {
    assert.deepEqual(Object.keys(sample), ["transition", "seconds"]); assert.ok(Object.isFrozen(sample));
  }
  assert.doesNotMatch(JSON.stringify(t.samples(NOW + 8000)), /prg_|tn_|epoch|revision|src_/);
});

test("draft source assignment and writer handoff are not source-change samples", () => {
  const t = new BroadcastProgramTransitions();
  assert.equal(t.observe(null, record("draft", { sourceIds: [] }), NOW), true);
  assert.equal(t.observe(record("draft", { sourceIds: [] }), record("draft", { sourceIds: [srcA] }), NOW + 100), true);
  assert.equal(t.observe(record("draft", { sourceIds: [srcA] }), record("live", { sourceIds: [srcA] }), NOW + 200), true);
  assert.deepEqual(seconds(t, "start", NOW + 200), [.2]);
  assert.deepEqual(seconds(t, "source-change", NOW + 200), [], "setting sources on draft is not a source-change");
  assert.equal(t.observe(record("live"), record("preparing", { epoch: 2, pending: true, sourceIds: [srcB] }), NOW + 300), true);
  assert.equal(t.observe(record("preparing", { epoch: 2, pending: true, sourceIds: [srcB] }), record("live", { epoch: 2, sourceIds: [srcB] }), NOW + 900), true);
  assert.deepEqual(seconds(t, "handoff", NOW + 900), [.6]);
  assert.deepEqual(seconds(t, "source-change", NOW + 900), [], "pending writer replacement is handoff even if sources also change");
  assert.equal(t.observe(record("live", { epoch: 2, sourceIds: [srcB] }), record("preparing", { epoch: 3, sourceIds: [srcB] }), NOW + 1000), true);
  assert.equal(t.observe(record("preparing", { epoch: 3, sourceIds: [srcB] }), record("live", { epoch: 3, sourceIds: [srcB] }), NOW + 1400), true);
  assert.deepEqual(seconds(t, "source-change", NOW + 1400), [], "same sources under a new epoch is not a source-change");
  assert.doesNotMatch(JSON.stringify(t.samples(NOW + 1400)), /src_|prg_|tn_/);
});

test("transition anchors ignore mismatched scopes, failed programs, direct stops and bad clocks", () => {
  const t = new BroadcastProgramTransitions();
  const other = "prg_bbbbbbbbbbbbbbbb";
  assert.equal(t.observe(record("draft"), record("live", { id: other }), NOW), false, "scope change is not a transition");
  assert.equal(t.observe(null, record("draft"), NOW), true);
  assert.equal(t.observe(record("draft"), record("failed"), NOW + 100), true);
  assert.equal(t.pendingPrograms, 0);
  assert.equal(t.observe(null, record("draft", { id: other }), NOW + 200), true);
  assert.equal(t.observe(record("draft", { id: other }), record("stopped", { id: other }), NOW + 300), true);
  assert.deepEqual(t.samples(NOW + 400), [], "a draft stopped without stopping phase has no measurable stop");
  assert.equal(t.observe(null, record("draft"), NOW + 500), true);
  assert.equal(t.observe(record("draft"), record("live"), NOW + 1000), true);
  assert.equal(t.samples(NOW + 1000).length, 1);
  assert.equal(t.samples(NOW + 16 * 60_000).length, 0, "the window is fifteen minutes");
  assert.equal(t.observe(null, record("draft"), NOW + 16 * 60_000 - 1), false, "clock rollback clears everything and is refused");
  assert.deepEqual(t.samples(NOW + 16 * 60_000), []); assert.equal(t.pendingPrograms, 0);
  const u = new BroadcastProgramTransitions();
  for (let i = 0; i < 300; i++) { u.observe(null, record("draft"), NOW + i * 10); u.observe(record("draft"), record("live"), NOW + i * 10 + 1); u.observe(record("live"), record("failed"), NOW + i * 10 + 2); }
  assert.equal(u.samples(NOW + 4000).length, 256, "bounded ring");
  u.destroy(); assert.equal(u.samples(NOW + 5000), null); assert.equal(u.observe(null, record("draft"), NOW + 6000), false);
});

test("real registry start and stop reach the windowed histogram through the bounded sampler", () => {
  let now = NOW;
  const owner = { issuer: "https://identity.example/realms/ananta", subject: "private-owner-canary", displayName: "private-name-canary" };
  const rooms = new RoomRegistry();
  const member = rooms.join("room-alpha", {}, "owner", now, { authenticated: true, principal: `${owner.issuer}|${owner.subject}`, deviceFingerprint: "a".repeat(43) }).peer;
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: { issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {} }, clock: () => now });
  const programId = runtime.createProgram(owner, member, { requestVersion: 1, roomId: "room-alpha", title: "private-title-canary", visibility: "private" }, now).control.programId;
  now += 1500;
  const prepared = runtime.prepareNativePublisher(owner, member, programId, { requestVersion: 1, trigger: "user-action",
    packagerId: "pkr_aaaaaaaaaaaaaaaa", sourceIds: ["src_aaaaaaaaaaaaaaaa"], requestedRenditions: 1, allowHardwareAcceleration: false }, request => request, now);
  now += 2000;
  runtime.markNativeOutputReady(prepared.admission.resourceRef, "pkr_aaaaaaaaaaaaaaaa", prepared.lease.fencingRevision, now);
  assert.deepEqual(runtime.transitionSamples(now), [{ transition: "start", seconds: 3.5 }]);
  assert.deepEqual(runtime.programQuotaCounts().programs, {
    deployment: { used: 1, limit: 32 }, gateway: { used: 1, limit: 16 }, tenant: { used: 1, limit: 8 }, principal: { used: 1, limit: 3 },
  });
  assert.doesNotMatch(JSON.stringify(runtime.programQuotaCounts()), /canary|prg_|tn_|sub_|pkr_|src_/);
  now += 1000; runtime.stopProgram(owner, programId, now);
  const metrics = new BroadcastRuntimeMetrics({ runtime, clock: () => now, host: { resourceCounts: () => ({ cpu: .25, ram: .5, disk: 1 }) } });
  const rows = metrics.snapshot();
  const start = rows.find(r => r.metric === "broadcast_program_transition_seconds" && r.labels.transition === "start");
  assert.equal(start.count, 1); assert.equal(start.sum, 3.5); assert.equal(start.buckets[6], 1, "3.5s falls into the 5s bucket");
  assert.equal(rows.some(r => r.metric === "broadcast_program_transition_seconds" && r.labels.transition === "stop"), false,
    "a stop that never left stopping..stopped within one commit is not invented");
  assert.deepEqual(rows.filter(r => r.metric === "broadcast_quota_ratio").map(r => [r.labels.scope, r.value]),
    [["deployment", 0], ["gateway", 0], ["tenant", 0], ["principal", 0]],
    "a stopped program releases occupancy; zero is a measured empty inventory, not a missing group");
  assert.deepEqual(rows.filter(r => r.metric === "broadcast_resource_utilization_ratio").map(r => [r.labels.component, r.labels.resource, r.value]),
    [["control-plane", "cpu", .25], ["control-plane", "ram", .5], ["control-plane", "disk", 1]]);
  assert.match(metrics.prometheus(), /broadcast_program_transition_seconds_bucket\{transition="start",le="5"\} 1\n/);
  assert.doesNotMatch(metrics.prometheus(), /canary|prg_|pkr_|src_/);
  runtime.closeProgramHistory(); assert.equal(runtime.transitionSamples(now + 1), null);
  metrics.destroy();
});

test("transition and host samples are validated atomically and cannot invent zeros", () => {
  for (const bad of [[{ transition: "start", seconds: -1 }], [{ transition: "reboot", seconds: 1 }], [{ transition: "start", seconds: 3601 }],
    [{ transition: "source-change", seconds: 1, sourceIds: [srcA] }], [{ transition: "start", seconds: 1, programId: program }],
    Array(257).fill({ transition: "stop", seconds: 1 }), "start"]) {
    assert.throws(() => transitionMetricSamples({ transitionSamples: () => bad }, NOW), /invalid_transition_metric_samples/);
  }
  assert.deepEqual(transitionMetricSamples({}, NOW), []);
  assert.deepEqual(transitionMetricSamples({ transitionSamples: () => [] }, NOW), []);
  for (const bad of [{ cpu: 1.1, ram: 0, disk: 0 }, { cpu: 0, ram: -1, disk: 0 }, { cpu: 0, ram: 0 }, { cpu: NaN, ram: 0, disk: 0 }, { cpu: 0, ram: 0, disk: 0, path: "/private" }]) {
    assert.throws(() => hostResourceMetricSamples({ resourceCounts: () => bad }), /invalid_host_resource_counts/);
  }
  assert.deepEqual(hostResourceMetricSamples(undefined), []);
  const counts = hostResourceCounts("/", { loadavg: () => [8, 0, 0], cpus: () => Array(4).fill({}), freemem: () => 250, totalmem: () => 1000,
    statfs: root => { assert.equal(root, "/"); return { blocks: 100, bavail: 30 }; } });
  assert.deepEqual(counts, { cpu: 1, ram: .75, disk: .7 }, "load beyond the core count saturates at one");
  const empty = hostResourceCounts("/", { loadavg: () => [0, 0, 0], cpus: () => [], freemem: () => 0, totalmem: () => 0, statfs: () => ({ blocks: 0, bavail: 0 }) });
  assert.ok(Object.values(empty).every(Number.isNaN), "unknown capacity is NaN and therefore rejected, not zero utilization");
  assert.throws(() => hostResourceMetricSamples({ resourceCounts: () => empty }));
  const actual = hostResourceCounts();
  assert.ok(["cpu", "ram", "disk"].every(k => actual[k] >= 0 && actual[k] <= 1));
  assert.deepEqual(quotaMetricSamples({}), []);
  for (const bad of [{ programs: {} }, { programs: { deployment: { used: 0, limit: 0 }, gateway: { used: 0, limit: 1 },
    tenant: { used: 0, limit: 1 }, principal: { used: 0, limit: 1 } } }, { programs: { deployment: { used: 1, limit: 8, tenantId: tenant },
    gateway: { used: 1, limit: 8 }, tenant: { used: 1, limit: 8 }, principal: { used: 1, limit: 8 } } }]) {
    assert.throws(() => quotaMetricSamples({ programQuotaCounts: () => bad }), /invalid_quota_metric_counts/);
  }
  assert.deepEqual(quotaMetricSamples({ programQuotaCounts: () => ({ programs: {
    deployment: { used: 0, limit: 32 }, gateway: { used: 0, limit: 16 }, tenant: { used: 0, limit: 8 }, principal: { used: 0, limit: 3 },
  } }) }).map(s => [s.labels.scope, s.value]), [["deployment", 0], ["gateway", 0], ["tenant", 0], ["principal", 0]]);
});
