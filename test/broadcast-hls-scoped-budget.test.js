import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { BroadcastHlsScopedBudget, hlsScopedBudgetsFromEnvironment } from "../src/broadcast-hls-scoped-budget.js";
import { loadConfig } from "../src/config.js";

const scope = (tenant = "a", audience = "a") => ({ tenantId: `tn_${tenant.repeat(16)}`, audienceRef: `sub_${audience.repeat(16)}` });
function fixture(options = {}) {
  let now = 0;
  const budget = new BroadcastHlsScopedBudget({ clock: () => typeof now === "function" ? now() : now, ...options });
  return { for: (tenant, audience) => budget.forScope(scope(tenant, audience)), budget, time: value => { now = value; } };
}

test("tenant and audience request denials charge none of the other scopes", () => {
  for (const limited of ["tenant", "audience"]) {
    const f = fixture({ deployment: { maximumRequestsPerSecond: 2 }, [limited]: { maximumRequestsPerSecond: 1 } });
    assert.equal(f.for("a", "a").request(), true);
    assert.equal(f.for("a", limited === "tenant" ? "b" : "a").request(), false);
    assert.equal(f.for("b", "a").request(), true, "other tenant retains its credit and the last global request");
    assert.equal(f.for("c", "c").request(), false, "global limit still applies");
    f.time(1000); assert.equal(f.for("a", "a").request(), true);
  }
});

test("byte charging is atomic; separate streams, program changes and repeated scope binding share balances", () => {
  for (const limited of ["tenant", "audience"]) {
    const f = fixture({ deployment: { egressBurstBytes: 8, maximumEgressBitsPerSecond: 32 }, [limited]: { egressBurstBytes: 4 } });
    assert.equal(f.for("a", "a").bytes(4), true);
    assert.equal(f.for("a", limited === "tenant" ? "b" : "a").bytes(1), false);
    assert.equal(f.for("b", "a").bytes(4), true);
    assert.equal(f.for("c", "a").bytes(1), false);
    f.time(250); assert.equal(f.for("a", "a").bytes(1), true);
    assert.equal(f.for("b", "b").bytes(1), false, "one refilled global byte cannot be spent twice");
  }
});

test("scope handles cannot reset credit by mutation, unknown fields or returning after safe eviction", () => {
  const f = fixture({ maximumBuckets: 2, deployment: { egressBurstBytes: 8, maximumEgressBitsPerSecond: 8 },
    tenant: { egressBurstBytes: 4 }, audience: { egressBurstBytes: 4 } });
  const input = scope(), old = f.budget.forScope(input);
  assert.equal(Object.isFrozen(old), true); input.tenantId = scope("b").tenantId;
  assert.equal(old.request(), true); assert.equal(old.bytes(4), true);
  const other = f.for("b", "b");
  assert.equal(other.request(), false, "exhausted buckets cannot be evicted for a new identity");
  f.time(4000); assert.equal(other.request(), true); assert.equal(other.bytes(4), true);
  assert.equal(old.bytes(1), false, "old handle cannot retain an independent evicted bucket");
  f.time(8000); assert.equal(old.bytes(4), true);
  assert.equal(f.for("a", "a").bytes(1), false, "old and new handles use the same recreated balance");
  for (const bad of [null, [], "x", {}, { ...scope(), programId: "prg_aaaaaaaaaaaaaaaa" },
    { ...scope(), tenantId: "sub_aaaaaaaaaaaaaaaa" }, { ...scope(), audienceRef: "secret-canary" },
    Object.assign(Object.create(scope()), { x: 1, y: 2 })]) assert.equal(f.budget.forScope(bad), null);
  assert.equal(JSON.stringify(f.budget), "{}");
});

test("zero scoped limits deny their demand; invalid clocks latch all scopes closed", () => {
  for (const where of ["tenant", "audience"]) for (const field of ["maximumRequestsPerSecond", "maximumEgressBitsPerSecond", "egressBurstBytes"]) {
    const f = fixture({ [where]: { [field]: 0 } }), a = f.for("a", "a");
    assert.equal(field === "maximumRequestsPerSecond" ? a.request() : a.bytes(1), false);
  }
  for (const bad of [0, -1, Infinity, NaN, "20", () => { throw Error("secret-clock-canary"); }]) {
    const f = fixture(); f.time(10); const a = f.for("a", "a"); assert.equal(a.request(), true);
    f.time(bad); assert.equal(a.bytes(1), false);
    f.time(1000); assert.equal(f.for("b", "b").request(), false);
  }
});

test("invalid charges never create credit, including malformed policy and maximum storage", () => {
  const f = fixture({ deployment: { egressBurstBytes: 4 } }), a = f.for("a", "a");
  for (const value of [-1, .5, "4", Infinity, NaN]) assert.equal(a.bytes(value), false);
  assert.equal(a.bytes(4), true); assert.equal(a.bytes(1), false);
  for (const options of [{ maximumBuckets: 1 }, { maximumBuckets: 8193 }, { clock: null }, { tenant: null },
    { audience: { secret: 1 } }, { deployment: { maximumRequestsPerSecond: 0 } }, { tenant: { egressBurstBytes: -1 } }]) {
    assert.throws(() => new BroadcastHlsScopedBudget(options), /invalid_broadcast_hls/);
  }
});

test("one clock sample fences all availability checks and debits of a decision", () => {
  let calls = 0;
  const budget = new BroadcastHlsScopedBudget({ clock: () => { calls++; return 1000; },
    deployment: { maximumRequestsPerSecond: 1, egressBurstBytes: 1 } });
  const handle = budget.forScope(scope());
  assert.equal(calls, 0);
  assert.equal(handle.request(), true); assert.equal(calls, 1);
  assert.equal(handle.bytes(1), true); assert.equal(calls, 2);
  assert.equal(handle.request(), false); assert.equal(calls, 3);
  assert.equal(handle.bytes(1), false); assert.equal(calls, 4);
});

test("all six scoped ENV limits inherit the actual global policy and reject malformed values", () => {
  const fields = { MAX_REQUESTS_PER_SECOND: ["maximumRequestsPerSecond", 10000],
    MAX_EGRESS_BITS_PER_SECOND: ["maximumEgressBitsPerSecond", 10000000000], EGRESS_BURST_BYTES: ["egressBurstBytes", 25165824] };
  for (const [suffix, [field, max]] of Object.entries(fields)) for (const [kind, end] of [["tenant", "TENANT"], ["audience", "AUDIENCE"]]) {
    const global = `BROADCAST_HLS_${suffix}`, env = `${global}_PER_${end}`;
    assert.equal(loadConfig({ [global]: "3" }).broadcastHlsScopedBudgets[kind][field], 3);
    for (const value of [0, max]) {
      const result = loadConfig({ [global]: "3", [env]: String(value) }).broadcastHlsScopedBudgets;
      assert.equal(result[kind][field], value); assert.ok(Object.isFrozen(result) && Object.isFrozen(result[kind]));
    }
    for (const value of ["", null, true, "-1", "1.5", "Infinity", String(max + 1)]) {
      assert.throws(() => hlsScopedBudgetsFromEnvironment({ [env]: value }), new RegExp(env));
    }
  }
});

test("Compose passes inherited, zero and explicit scoped limits to the application", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BROADCAST_HLS_")));
  const result = JSON.parse(execFileSync("docker", ["compose", "--env-file", "/dev/null", "config", "--format", "json"], {
    env: { ...env, BROADCAST_HLS_MAX_REQUESTS_PER_SECOND: "17", BROADCAST_HLS_MAX_REQUESTS_PER_SECOND_PER_TENANT: "0",
      BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND: "64", BROADCAST_HLS_EGRESS_BURST_BYTES: "32",
      BROADCAST_HLS_EGRESS_BURST_BYTES_PER_AUDIENCE: "4" }, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  })).services.webrtc.environment;
  assert.equal(result.BROADCAST_HLS_MAX_REQUESTS_PER_SECOND, "17");
  assert.equal(result.BROADCAST_HLS_MAX_REQUESTS_PER_SECOND_PER_TENANT, "0");
  assert.equal(result.BROADCAST_HLS_MAX_REQUESTS_PER_SECOND_PER_AUDIENCE, "17");
  assert.equal(result.BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND_PER_TENANT, "64");
  assert.equal(result.BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND_PER_AUDIENCE, "64");
  assert.equal(result.BROADCAST_HLS_EGRESS_BURST_BYTES_PER_TENANT, "32");
  assert.equal(result.BROADCAST_HLS_EGRESS_BURST_BYTES_PER_AUDIENCE, "4");
});

test("Compose preserves explicit empty limits so startup cannot silently substitute a default", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BROADCAST_HLS_")));
  const result = JSON.parse(execFileSync("docker", ["compose", "--env-file", "/dev/null", "config", "--format", "json"], {
    env: { ...env, BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND: "", BROADCAST_HLS_EGRESS_BURST_BYTES_PER_AUDIENCE: "" },
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  })).services.webrtc.environment;
  assert.equal(result.BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND, "");
  assert.equal(result.BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND_PER_TENANT, "");
  assert.equal(result.BROADCAST_HLS_EGRESS_BURST_BYTES_PER_AUDIENCE, "");
  assert.throws(() => hlsScopedBudgetsFromEnvironment(result), /BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND/);
});
