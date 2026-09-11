import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";
import { BroadcastHlsTraffic } from "../src/broadcast-hls-traffic.js";
import { BroadcastRuntimeMetrics } from "../src/broadcast-runtime-metrics.js";

const zero = { activeRequests: 0, activeSessions: 0, bodyBytes: 0, completed: 0, cancelled: 0, failed: 0 };
const request = { method: "GET", resourceRef: "private-resource-canary" };
const options = fetchImpl => ({ sessions: { create() {}, renew() {},
  async authorize(input) { if (input.denied) throw new Error("denied"); return { sessionId: input.session || "private-session-canary",
    budgetScope: { tenantId: "tn_aaaaaaaaaaaaaaaa", audienceRef: "sub_aaaaaaaaaaaaaaaa" },
    upstreamPath: "/private-path-canary", authorizationHeader: "Bearer private-token-canary" }; } },
  gatewayOrigin: "https://gateway.example", fetchImpl, maximumConcurrentRequests: 2, maximumConcurrentPerSession: 2,
  idleTimeoutMs: 100, streamTimeoutMs: 1000 });
const body = () => new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(7)); } }, { highWaterMark: 0 });
const response = stream => new Response(stream, { headers: { "content-type": "video/mp4" } });

test("HLS counts actual downstream demand, distinguishes requests from sessions and finalizes once", async () => {
  const proxy = new BroadcastHlsProxy(options(async () => response(body())));
  assert.deepEqual(proxy.trafficCounts(), zero);
  await assert.rejects(proxy.fetchMedia({ ...request, denied: true }));
  assert.deepEqual(proxy.trafficCounts(), zero);
  const first = await proxy.fetchMedia(request), second = await proxy.fetchMedia(request);
  assert.deepEqual(proxy.trafficCounts(), { ...zero, activeRequests: 2, activeSessions: 1 });
  await assert.rejects(proxy.fetchMedia(request), /temporarily_unavailable/);
  assert.equal(proxy.trafficCounts().failed, 0, "quota rejection is not an admitted upstream failure");
  const reader = first.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 7);
  assert.equal(proxy.trafficCounts().bodyBytes, 7);
  await reader.cancel(); await reader.cancel();
  assert.deepEqual(proxy.trafficCounts(), { ...zero, bodyBytes: 7, cancelled: 1, activeRequests: 1, activeSessions: 1 });
  await second.body.cancel();
  assert.deepEqual(proxy.trafficCounts(), { ...zero, bodyBytes: 7, cancelled: 2 });
  assert.equal(Object.isFrozen(proxy.trafficCounts()), true);
  assert.doesNotMatch(JSON.stringify(proxy.trafficCounts()), /private-|Bearer|gateway/);
});

test("EOF and HEAD complete once, rejected upstreams and read failures remain separate failures", async () => {
  let mode = "eof";
  const proxy = new BroadcastHlsProxy(options(async () => {
    if (mode === "network") throw new Error("private-upstream");
    if (mode === "status") return new Response(body(), { status: 403 });
    if (mode === "mime") return new Response(body(), { headers: { "content-type": "text/html" } });
    if (mode === "read") return response(new ReadableStream({ pull() { throw new Error("private-upstream"); } }));
    return response(new Uint8Array(9));
  }));
  const media = await proxy.fetchMedia(request);
  const reader = media.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 9);
  assert.equal((await reader.read()).done, true);
  await reader.cancel(); reader.releaseLock();
  assert.deepEqual(proxy.trafficCounts(), { ...zero, bodyBytes: 9, completed: 1 });
  assert.equal((await proxy.fetchMedia({ ...request, method: "HEAD" })).body, null);
  for (const value of ["network", "status", "mime"]) { mode = value; await assert.rejects(proxy.fetchMedia(request)); }
  mode = "read";
  await assert.rejects(new Response((await proxy.fetchMedia(request)).body).arrayBuffer(), /stream_failed/);
  assert.deepEqual(proxy.trafficCounts(), { ...zero, bodyBytes: 9, completed: 2, failed: 4 });
});

test("idle timeout counts a failure, not cancellation, even when late cancellation follows", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proxy = new BroadcastHlsProxy(options(async () => response(body())));
  const media = await proxy.fetchMedia(request);
  t.mock.timers.tick(101);
  await assert.rejects(media.body.cancel(), /stream_timeout/);
  assert.deepEqual(proxy.trafficCounts(), { ...zero, failed: 1 });
});

test("overflow and malformed counter inputs become unavailable without throwing or exposing last-good totals", () => {
  const traffic = new BroadcastHlsTraffic();
  traffic.bytes(Number.MAX_SAFE_INTEGER);
  assert.equal(traffic.snapshot(0, 0).bodyBytes, Number.MAX_SAFE_INTEGER);
  traffic.bytes(1); assert.equal(traffic.snapshot(0, 0), null);
  traffic.finished("completed"); assert.equal(traffic.snapshot(0, 0), null);
  for (const value of [-1, 0.5, NaN, Infinity, "7"]) {
    const invalid = new BroadcastHlsTraffic(); invalid.bytes(value); assert.equal(invalid.snapshot(0, 0), null);
  }
  const invalid = new BroadcastHlsTraffic(); invalid.finished("private-name"); assert.equal(invalid.snapshot(0, 0), null);
});

test("proxy metrics use the shared sampling interval and do not double-add cumulative counters", async () => {
  let now = 1000;
  const proxy = new BroadcastHlsProxy(options(async () => response(new Uint8Array(12))));
  const metrics = new BroadcastRuntimeMetrics({ hlsProxy: proxy, clock: () => now });
  assert.equal(metrics.snapshot().length, 6);
  await new Response((await proxy.fetchMedia(request)).body).arrayBuffer();
  assert.match(metrics.prometheus(), /body_bytes_total 0\n/);
  now += 15000;
  assert.match(metrics.prometheus(), /body_bytes_total 12\n/);
  assert.match(metrics.prometheus(), /requests_total\{outcome="completed"\} 1\n/);
  now += 15000;
  assert.match(metrics.prometheus(), /body_bytes_total 12\n/);
  metrics.destroy(); assert.equal(metrics.prometheus(), "");
});

test("one invalid metric source never hides the other or fabricates zero traffic", () => {
  let now = 1000, traffic = zero;
  const counts = Object.fromEntries(["draft", "preparing", "awaiting_consent", "publishing", "live", "degraded", "stopping", "stopped", "failed"].map(state => [state, 0]));
  const metrics = new BroadcastRuntimeMetrics({ clock: () => now,
    runtime: { programStateCounts: () => counts }, hlsProxy: { trafficCounts: () => traffic } });
  assert.equal(metrics.snapshot().length, 15);
  for (const bad of [null, {}, [], { ...zero, privateField: 1 }, { ...zero, bodyBytes: -1 },
    { ...zero, completed: Infinity }, { ...zero, activeRequests: 10001 }, { ...zero, activeSessions: 1 }]) {
    traffic = bad; now += 15000;
    assert.equal(metrics.snapshot().length, 9);
    assert.doesNotMatch(metrics.prometheus(), /hls_proxy/);
  }
  const healthyProxy = new BroadcastRuntimeMetrics({ runtime: { programStateCounts() { throw new Error("private"); } },
    hlsProxy: { trafficCounts: () => zero } });
  assert.equal(healthyProxy.snapshot().length, 6);
});
