import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BROADCAST_PROGRAM_STATES } from "../src/broadcast-program-model.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { BroadcastRuntimeMetrics } from "../src/broadcast-runtime-metrics.js";
import { createAppServer } from "../src/server.js";

const NOW = 1_800_000_000_000;
const empty = () => Object.fromEntries(BROADCAST_PROGRAM_STATES.map(state => [state, 0]));
const values = metrics => Object.fromEntries(metrics.snapshot().map(row => [row.labels.state, row.value]));
function fixture() {
  const owner = { issuer: "https://identity.example/realms/ananta", subject: "private-owner-canary",
    displayName: "private-name-canary" };
  const member = { principal: `${owner.issuer}|${owner.subject}`, roomId: "private-room-canary",
    creator: true, deviceFingerprint: "a".repeat(43) };
  const runtime = new BroadcastRuntimeRegistry({ grantAuthority: {
    issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {},
  }, clock: () => NOW });
  const create = () => runtime.createProgram(owner, member, {
    requestVersion: 1, roomId: member.roomId, title: "private-title-canary", visibility: "private",
  });
  return { runtime, owner, member, create };
}

test("control metrics cover exactly the contract states, without invented delivery profiles", () => {
  const schema = JSON.parse(readFileSync("contracts/broadcast/broadcast-program.v1.schema.json", "utf8"));
  assert.deepEqual(BROADCAST_PROGRAM_STATES, schema.properties.state.enum);
});

test("real registry create, rejected stop, stop and idempotent stop update anonymous counts only", () => {
  const { runtime, owner, create } = fixture();
  assert.deepEqual(runtime.programStateCounts(), empty());
  const first = create().program.programId;
  const second = create().program.programId;
  const before = runtime.programStateCounts();
  assert.deepEqual(before, { ...empty(), draft: 2 });
  assert.throws(() => { before.draft = 999; }, TypeError);
  assert.throws(() => runtime.stopProgram({ ...owner, subject: "other" }, first), /broadcast_not_available/);
  assert.deepEqual(runtime.programStateCounts(), before);
  runtime.stopProgram(owner, first);
  runtime.stopProgram(owner, first);
  assert.deepEqual(runtime.programStateCounts(), { ...empty(), draft: 1, stopped: 1 });
  runtime.stopProgram(owner, second);
  assert.deepEqual(runtime.programStateCounts(), { ...empty(), stopped: 2 });
  const metrics = new BroadcastRuntimeMetrics({ runtime, clock: () => NOW });
  assert.deepEqual(values(metrics), { ...empty(), stopped: 2 });
  const serialized = JSON.stringify(metrics.snapshot()) + metrics.prometheus();
  for (const canary of [first, second, "private-owner-canary", "private-room-canary", "private-title-canary", "private-name-canary", "identity.example"]) {
    assert.equal(serialized.includes(canary), false);
  }
  assert.equal(metrics.snapshot().every(row => row.metric === "broadcast_control_programs"
    && Object.keys(row.labels).join() === "state"), true);
});

test("sampling is bounded to 15s across both ports and replaces old states with zero", () => {
  let now = NOW, calls = 0, counts = { ...empty(), live: 2 };
  const metrics = new BroadcastRuntimeMetrics({ clock: () => now, runtime: {
    programStateCounts() { calls++; return counts; },
  } });
  assert.equal(values(metrics).live, 2);
  counts = { ...empty(), stopped: 2 };
  now += 14_999;
  for (let i = 0; i < 50; i++) { metrics.snapshot(); metrics.prometheus(); }
  assert.equal(calls, 1);
  now++;
  assert.deepEqual(values(metrics), counts);
  assert.equal(calls, 2);
  assert.match(metrics.prometheus(), /broadcast_control_programs\{state="live"\} 0/);
  metrics.destroy(); metrics.destroy();
  now += 30_000;
  assert.deepEqual(metrics.snapshot(), []);
  assert.equal(metrics.prometheus(), "");
  assert.equal(calls, 2);
});

test("failed sampling clears last-good values without retry storms or leaking error content", () => {
  let now = NOW, calls = 0;
  const metrics = new BroadcastRuntimeMetrics({ clock: () => now, runtime: {
    programStateCounts() {
      calls++;
      if (calls > 1) throw new Error("Bearer private-token-caption-203.0.113.42");
      return { ...empty(), live: 1 };
    },
  } });
  assert.equal(values(metrics).live, 1);
  now += 15_000;
  assert.deepEqual(metrics.snapshot(), []);
  assert.equal(metrics.prometheus(), "");
  assert.equal(calls, 2);
});

test("invalid, missing and unexpected aggregate fields never generate partial success", () => {
  for (const counts of [null, [], {}, { ...empty(), privateRoom: 1 },
    { ...empty(), live: -1 }, { ...empty(), live: 0.5 }, { ...empty(), live: Infinity },
    { ...empty(), live: "1" }, { ...empty(), live: 10_001 }, { ...empty(), live: 6000, draft: 4001 }]) {
    const metrics = new BroadcastRuntimeMetrics({ clock: () => NOW, runtime: { programStateCounts: () => counts } });
    assert.deepEqual(metrics.snapshot(), []);
    assert.equal(metrics.prometheus(), "");
  }
  for (const runtime of [null, undefined, {}]) {
    assert.deepEqual(new BroadcastRuntimeMetrics({ runtime }).snapshot(), []);
  }
});

test("clock rollback and invalid clocks clear old samples, then recover within the sampling bound", () => {
  let now = NOW, calls = 0;
  const metrics = new BroadcastRuntimeMetrics({ clock: () => now, runtime: {
    programStateCounts() { calls++; return empty(); },
  } });
  metrics.snapshot(); now--;
  assert.deepEqual(metrics.snapshot(), []);
  assert.equal(calls, 1);
  now += 15_000;
  assert.deepEqual(values(metrics), empty());
  assert.equal(calls, 2);
  for (const bad of [NaN, Infinity, -1, 1.5, "now"]) {
    now = bad;
    assert.deepEqual(metrics.snapshot(), []);
  }
  assert.equal(calls, 2);
});

test("default app exposes only the in-process read port and erases it on actual server close", async t => {
  const { runtime, create } = fixture();
  create();
  const app = createAppServer({ config: { authMode: "disabled", pairWorkspaceEnabled: false }, broadcastRuntime: runtime });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  assert.deepEqual(values(app.broadcastMetrics), { ...empty(), draft: 1 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of ["/metrics", "/api/broadcasts/metrics"]) {
    const response = await fetch(url + path);
    assert.doesNotMatch(await response.text(), /broadcast_control_programs/);
  }
  await new Promise(resolve => app.server.close(resolve));
  assert.deepEqual(app.broadcastMetrics.snapshot(), []);
  assert.equal(app.broadcastMetrics.prometheus(), "");
});
