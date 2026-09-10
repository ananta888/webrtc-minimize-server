import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";
import { BroadcastHlsBudget, BROADCAST_HLS_BUDGET_DEFAULTS } from "../src/broadcast-hls-budget.js";
import { loadConfig } from "../src/config.js";

function fixture(limits = {}) {
  let now = 0, requests = 0, cancelled = 0;
  const sessions = { create() {}, renew() {}, authorize: async input => ({ sessionId: input.session,
    upstreamPath: "/res_aaaaaaaaaaaaaaaa/live.m4s", authorizationHeader: "Bearer synthetic",
    cacheControl: "private, no-store" }) };
  const proxy = new BroadcastHlsProxy({ sessions, gatewayOrigin: "http://fixture.invalid", clock: () => now,
    ...limits, fetchImpl: async () => {
      requests++;
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "video/mp4" } });
    } });
  return { proxy, time: value => { now = value; }, requests: () => requests, cancelled: () => cancelled,
    fetch: session => proxy.fetchMedia({ method: "GET", session }) };
}

test("the real proxy rejects aggregate request excess before upstream allocation", async () => {
  const f = fixture({ maximumRequestsPerSecond: 1 });
  const first = await f.fetch("one"); await first.body.cancel();
  const second = await f.fetch("two").catch(error => error);
  if (second.body) await second.body.cancel();
  assert.equal(second.status, 429);
  assert.equal(f.requests(), 1);
  f.time(1000); const next = await f.fetch("two"); await next.body.cancel();
  assert.equal(f.requests(), 2);
  assert.equal(f.proxy.trafficCounts().activeRequests, 0);
});

test("aggregate byte exhaustion aborts before enqueue and releases only the affected slot", async () => {
  const f = fixture({ maximumEgressBitsPerSecond: 32, egressBurstBytes: 8 });
  const first = await f.fetch("one"), second = await f.fetch("two");
  const a = first.body.getReader(), b = second.body.getReader();
  try {
    assert.equal((await a.read()).value.byteLength, 4);
    assert.equal((await b.read()).value.byteLength, 4);
    await assert.rejects(a.read(), error => error.status === 429);
    assert.equal(f.cancelled(), 1);
    assert.deepEqual(f.proxy.trafficCounts(), { activeRequests: 1, activeSessions: 1,
      bodyBytes: 8, completed: 0, cancelled: 0, failed: 1 });
    f.time(1000); assert.equal((await b.read()).value.byteLength, 4);
  } finally { await a.cancel().catch(() => {}); await b.cancel().catch(() => {}); }
  assert.equal(f.cancelled(), 2);
  assert.equal(f.proxy.trafficCounts().activeRequests, 0);
});

test("budgets refill fractionally, cap idle credit and never refund cancellation", () => {
  let now = 0;
  const budget = new BroadcastHlsBudget({ maximumRequestsPerSecond: 2, maximumEgressBitsPerSecond: 32,
    egressBurstBytes: 8, clock: () => now });
  assert.equal(budget.request(), true); assert.equal(budget.request(), true); assert.equal(budget.request(), false);
  assert.equal(budget.bytes(8), true); assert.equal(budget.bytes(1), false);
  now = 250;
  assert.equal(budget.request(), false); assert.equal(budget.bytes(1), true);
  now = 500;
  assert.equal(budget.request(), true); assert.equal(budget.request(), false);
  assert.equal(budget.bytes(1), true);
  now = 100_000;
  assert.equal(budget.bytes(9), false); assert.equal(budget.bytes(8), true); assert.equal(budget.bytes(1), false);
  assert.equal(budget.request(), true); assert.equal(budget.request(), true); assert.equal(budget.request(), false);
});

test("bad clocks latch closed without future credit or thrown transport errors", () => {
  for (const bad of [-1, 9, NaN, Infinity, "10", () => { throw new Error("sensitive clock error"); }]) {
    let now = 10;
    const budget = new BroadcastHlsBudget({ clock: () => typeof now === "function" ? now() : now });
    assert.equal(budget.request(), true);
    now = bad; assert.equal(budget.bytes(0), false);
    now = 1_000_000; assert.equal(budget.request(), false); assert.equal(budget.bytes(0), false);
  }
});

test("invalid byte values cannot create credit and request/body budgets are independent", () => {
  const budget = new BroadcastHlsBudget({ maximumRequestsPerSecond: 1, egressBurstBytes: 4, clock: () => 0 });
  for (const invalid of [-1, NaN, Infinity, "4", 0.5]) assert.equal(budget.bytes(invalid), false);
  assert.equal(budget.bytes(4), true); assert.equal(budget.bytes(1), false);
  assert.equal(budget.request(), true); assert.equal(budget.request(), false);
});

test("operator environment has bounded defaults and rejects disabled/unbounded policies", () => {
  const config = loadConfig({});
  assert.equal(config.broadcastHlsMaximumRequestsPerSecond, BROADCAST_HLS_BUDGET_DEFAULTS.maximumRequestsPerSecond);
  assert.equal(config.broadcastHlsMaximumEgressBitsPerSecond, BROADCAST_HLS_BUDGET_DEFAULTS.maximumEgressBitsPerSecond);
  assert.equal(config.broadcastHlsEgressBurstBytes, BROADCAST_HLS_BUDGET_DEFAULTS.egressBurstBytes);
  for (const [env, property, option, maximum] of [
    ["BROADCAST_HLS_MAX_REQUESTS_PER_SECOND", "broadcastHlsMaximumRequestsPerSecond", "maximumRequestsPerSecond", 10_000],
    ["BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND", "broadcastHlsMaximumEgressBitsPerSecond", "maximumEgressBitsPerSecond", 10_000_000_000],
    ["BROADCAST_HLS_EGRESS_BURST_BYTES", "broadcastHlsEgressBurstBytes", "egressBurstBytes", 24 * 1024 * 1024],
  ]) {
    for (const valid of [1, maximum]) {
      assert.equal(loadConfig({ [env]: String(valid) })[property], valid);
      assert.doesNotThrow(() => new BroadcastHlsBudget({ [option]: valid }));
    }
    for (const invalid of [0, -1, maximum + 1, 1.5, NaN, Infinity]) {
      assert.throws(() => loadConfig({ [env]: String(invalid) }), new RegExp(env));
      assert.throws(() => new BroadcastHlsBudget({ [option]: invalid }), /configuration/);
    }
  }
  assert.throws(() => new BroadcastHlsBudget({ clock: null }), /configuration/);
});
