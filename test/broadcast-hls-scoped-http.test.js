import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createAppServer } from "../src/server.js";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";
import { BroadcastPlaybackSessionStore } from "../src/broadcast-playback-session-store.js";

const origin = "https://synthetic-playback.example.test", resourceRef = "res_aaaaaaaaaaaaaaaa";
const cookie = session => session.setCookie[0].split(";", 1)[0];
function storeFixture() {
  const grants = new Map(); let sequence = 0;
  const store = new BroadcastPlaybackSessionStore({ publicOrigin: origin, monotonicClock: () => 0, authority: {
    async authorizeGatewayBearer(header, expectation, now) {
      const grant = grants.get(header);
      if (!grant || expectation.path !== `/broadcast/play/${grant.resourceRef}`) throw Error("denied");
      return { ...grant, expiresAt: now + 60000 };
    },
  } });
  const create = async (tenant = "a", audience = "a", resource = "a") => {
    const authorizationHeader = `Bearer synthetic-${++sequence}`;
    grants.set(authorizationHeader, { grantKind: "playback", tenantId: `tn_${tenant.repeat(16)}`,
      audienceRef: `sub_${audience.repeat(16)}`, programId: `prg_${resource.repeat(16)}`, resourceRef: `res_${resource.repeat(16)}` });
    const session = await store.create({ origin, resourceRef: grants.get(authorizationHeader).resourceRef, authorizationHeader });
    return { session, authorizationHeader, resourceRef: grants.get(authorizationHeader).resourceRef };
  };
  return { store, create, input: f => ({ origin, method: "HEAD", resourceRef: f.resourceRef, file: "index.m3u8", cookieHeader: cookie(f.session) }) };
}

for (const scope of ["tenant", "audience"]) test(`verified ${scope} scope persists across tabs, programs, renewal and forged request scopes`, async () => {
  const f = storeFixture(); let upstreams = 0;
  const proxy = new BroadcastHlsProxy({ sessions: f.store, gatewayOrigin: "http://upstream.invalid", clock: () => 0,
    scopedBudgets: { [scope]: { maximumRequestsPerSecond: 2 } }, fetchImpl: async () => {
      upstreams++; return new Response(null, { headers: { "content-type": "video/mp4" } });
    } });
  const a = await f.create(), tab = await f.create(), program = await f.create("a", "a", "b");
  const firstScope = (await f.store.authorize(f.input(a))).budgetScope;
  assert.deepEqual(firstScope, { tenantId: "tn_aaaaaaaaaaaaaaaa", audienceRef: "sub_aaaaaaaaaaaaaaaa" });
  assert.ok(Object.isFrozen(firstScope));
  assert.equal(Object.hasOwn(a.session, "budgetScope"), false, "internal quota scope is not in the public session reply");
  await proxy.fetchMedia(f.input(a)); await proxy.fetchMedia(f.input(tab));
  await f.store.renew({ origin, sessionId: a.session.playbackSessionId, cookieHeader: cookie(a.session),
    resourceRef, authorizationHeader: a.authorizationHeader });
  for (const item of [a, program]) await assert.rejects(proxy.fetchMedia({ ...f.input(item),
    budgetScope: { tenantId: "tn_bbbbbbbbbbbbbbbb", audienceRef: "sub_bbbbbbbbbbbbbbbb" } }),
  error => error.status === 429 && error.code === "broadcast_playback_temporarily_unavailable");
  assert.equal(upstreams, 2);
  const otherViewer = await f.create("a", "b");
  if (scope === "tenant") await assert.rejects(proxy.fetchMedia(f.input(otherViewer)), error => error.status === 429);
  else await proxy.fetchMedia(f.input(otherViewer));
  await proxy.fetchMedia(f.input(await f.create("b", "a")));
  assert.equal(upstreams, scope === "tenant" ? 3 : 4);
  assert.equal(proxy.trafficCounts().activeRequests, 0);
});

for (const scope of ["TENANT", "AUDIENCE"]) for (const metric of ["MAX_REQUESTS_PER_SECOND", "MAX_EGRESS_BITS_PER_SECOND", "EGRESS_BURST_BYTES"]) {
  test(`actual server applies ${metric}_PER_${scope} before allocating or delivering media`, async t => {
    let upstreams = 0;
    const upstream = http.createServer((_request, response) => {
      upstreams++; response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }); response.end("#EXTM3U\n");
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
    const f = storeFixture(), one = await f.create();
    const config = loadConfig({ PUBLIC_ORIGIN: origin, AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false",
      BROADCAST_GATEWAY_ORIGIN: `http://127.0.0.1:${upstream.address().port}`, [`BROADCAST_HLS_${metric}_PER_${scope}`]: "0" });
    const app = createAppServer({ config, broadcastPlaybackSessions: f.store });
    t.after(async () => {
      for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
        for (const socket of server.clients) socket.terminate();
      }
      app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const read = () => fetch(base + one.session.manifestUrl, { headers: { origin, cookie: cookie(one.session) }, signal: AbortSignal.timeout(5000) });
    if (metric === "MAX_REQUESTS_PER_SECOND") {
      const response = await read();
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), { error: "broadcast_playback_temporarily_unavailable" });
      assert.equal(upstreams, 0);
    } else {
      // A first-chunk denial may close the socket before headers reach the
      // client, or after headers but before its body. Neither delivers media.
      await assert.rejects(async () => {
        const response = await read(); assert.equal(response.status, 200);
        await response.text();
      }, /fetch failed|terminated|socket|aborted/i);
      assert.equal(upstreams, 1);
    }
    const missing = await fetch(base + one.session.manifestUrl, { headers: { origin }, signal: AbortSignal.timeout(5000) });
    assert.equal(missing.status, 404); await missing.arrayBuffer();
    const health = await fetch(base + "/healthz", { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200); await health.arrayBuffer();
  });
}

test("proxy requires the internal verified scope instead of falling back to request input", async () => {
  let upstreams = 0;
  const proxy = new BroadcastHlsProxy({ gatewayOrigin: "http://upstream.invalid", sessions: {
    create() {}, renew() {}, authorize: async () => ({ sessionId: "synthetic-session" }),
  }, fetchImpl: async () => { upstreams++; throw Error("must not fetch"); } });
  await assert.rejects(proxy.fetchMedia({ method: "HEAD", budgetScope: { tenantId: "tn_aaaaaaaaaaaaaaaa", audienceRef: "sub_aaaaaaaaaaaaaaaa" } }),
    error => error.status === 429);
  assert.equal(upstreams, 0);
});
