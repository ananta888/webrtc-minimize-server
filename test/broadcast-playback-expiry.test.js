import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastPlaybackSessionStore } from "../src/broadcast-playback-session-store.js";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";
import { createAppServer } from "../src/server.js";

const NOW = 1800000000000, origin = "https://playback.example.test", resourceRef = "res_aaaaaaaaaaaaaaaa";
function fixture(options = {}) {
  let mono = 0, expiry = NOW + 1000, onAuthorize = () => {}, allocations = 0;
  const calls = [];
  const store = new BroadcastPlaybackSessionStore({ publicOrigin: origin, monotonicClock: () => mono,
    idFactory: () => { options.onAllocate?.(); return `pbs_${String(++allocations).padStart(24, "a")}`; }, authority: {
      async authorizeGatewayBearer(header, expectation, now) {
        calls.push({ action: expectation.action, now });
        const value = { grantKind: "playback", tenantId: "tn_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa",
          audienceRef: "sub_aaaaaaaaaaaaaaaa", resourceRef, expiresAt: expiry };
        await onAuthorize(expectation.action);
        return value;
      },
    }, ...options.store });
  const create = () => store.create({ authorizationHeader: "Bearer synthetic", origin, resourceRef, now: NOW });
  const request = session => ({ authorizationHeader: "Bearer synthetic", origin, resourceRef, now: NOW,
    sessionId: session.playbackSessionId, cookieHeader: session.setCookie[0].split(";", 1)[0] });
  return { store, calls, create, request, allocations: () => allocations,
    setMono: value => { mono = value; }, setExpiry: value => { expiry = value; },
    onAuthorize: fn => { onAuthorize = fn; } };
}

test("each grant check receives fresh time and cookie age excludes elapsed verification", async () => {
  const f = fixture(); f.setExpiry(NOW + 60000);
  f.onAuthorize(action => f.setMono(action === "playback:manifest" ? 250.25 : 500.25));
  const session = await f.create();
  assert.deepEqual(f.calls, [{ action: "playback:manifest", now: NOW }, { action: "playback:segment", now: NOW + 251 }]);
  assert.equal(session.expiresAt, NOW + 60000);
  assert.ok(session.setCookie.every(cookie => cookie.includes("Max-Age=59;")));
});

test("fractional elapsed time never extends the exact grant expiry boundary", async () => {
  for (const elapsed of [999, 999.1, 1000]) {
    const f = fixture(); f.onAuthorize(() => f.setMono(elapsed));
    if (elapsed === 999) assert.equal((await f.create()).expiresAt, NOW + 1000);
    else await assert.rejects(f.create(), error => error.status === 404);
  }
});

test("expiry during synchronous allocation cannot commit a cookie", async () => {
  const f = fixture({ onAllocate: () => f.setMono(1000) });
  await assert.rejects(f.create(), error => error.status === 404);
  assert.equal(f.allocations(), 1); assert.equal(f.store.size, 0);
});

test("an expired new renewal grant leaves an unexpired original cookie unchanged", async () => {
  const f = fixture(); f.setExpiry(NOW + 60000);
  const session = await f.create();
  f.setExpiry(NOW + 1000); f.onAuthorize(() => f.setMono(1000));
  await assert.rejects(f.store.renew(f.request(session)), error => error.status === 404);
  assert.equal(f.store.size, 1);
  f.onAuthorize(() => {}); f.setExpiry(NOW + 60000);
  await f.store.authorize({ ...f.request(session), now: NOW + 1000, method: "GET", file: "index.m3u8" });
});

test("invalid clocks, intermediate rollback and epoch overflow fail without private exception leakage", async () => {
  for (const value of [NaN, Infinity, -1, "time", Number.MAX_VALUE]) {
    const f = fixture(); f.onAuthorize(() => f.setMono(value));
    await assert.rejects(f.create(), error => error.status === 404 && error.message === "broadcast_playback_not_found");
    assert.equal(f.store.size, 0);
  }
  const rollback = fixture();
  rollback.onAuthorize(action => rollback.setMono(action === "playback:manifest" ? 10 : 9));
  await assert.rejects(rollback.create(), error => error.status === 404);
  const throwing = fixture({ store: { monotonicClock() { throw new Error("private-token"); } } });
  await assert.rejects(throwing.create(), error => error.message === "broadcast_playback_not_found");
  for (const monotonicClock of [1, null, "time", {}]) {
    assert.throws(() => fixture({ store: { monotonicClock } }), /invalid_broadcast_playback_session_configuration/);
  }
  let mono = 0;
  const overflow = fixture({ store: { monotonicClock: () => mono++ } });
  await assert.rejects(overflow.store.create({ authorizationHeader: "Bearer synthetic", origin, resourceRef,
    now: Number.MAX_SAFE_INTEGER }), error => error.status === 404);
  assert.equal(overflow.calls.length, 0);
});

test("expired occupancy is pruned at the fresh commit time before evaluating session quota", async () => {
  const f = fixture({ store: { capacityLimits: { program: 1 } } });
  const first = await f.create();
  f.setExpiry(NOW + 2000); f.onAuthorize(() => f.setMono(1000));
  const replacement = await f.create();
  assert.notEqual(replacement.playbackSessionId, first.playbackSessionId);
  assert.equal(f.store.size, 1);
  await assert.rejects(f.store.authorize({ ...f.request(first), now: NOW + 1000, method: "GET", file: "index.m3u8" }),
    error => error.status === 404);
});

test("HTTP refuses a media request expiring in authorization before any upstream fetch", async t => {
  const epoch = Date.now(); let mono = 0, expireInAuthorization = false, upstreams = 0;
  const sessions = new BroadcastPlaybackSessionStore({ publicOrigin: origin, monotonicClock: () => mono, authority: {
    async authorizeGatewayBearer() {
      if (expireInAuthorization) mono += 60000;
      return { grantKind: "playback", tenantId: "tn_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa",
        audienceRef: "sub_aaaaaaaaaaaaaaaa", resourceRef, expiresAt: epoch + 60000 };
    },
  } });
  const session = await sessions.create({ authorizationHeader: "Bearer synthetic", origin, resourceRef, now: epoch });
  const proxy = new BroadcastHlsProxy({ sessions, gatewayOrigin: "http://127.0.0.1:9", fetchImpl: async () => {
    upstreams++; return new Response("#EXTM3U\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  } });
  const app = createAppServer({ config: { publicOrigin: origin, authMode: "disabled", pairWorkspaceEnabled: false }, broadcastHlsProxy: proxy });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  expireInAuthorization = true;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base + session.manifestUrl, { headers: { origin,
    cookie: session.setCookie[0].split(";", 1)[0] } });
  assert.equal(response.status, 404); assert.equal(response.headers.get("set-cookie"), null);
  assert.doesNotMatch(await response.text(), /synthetic|tenant|program|Bearer/);
  assert.equal(upstreams, 0); assert.equal(sessions.size, 0);
  const health = await fetch(base + "/healthz"); assert.equal(health.status, 200); await health.arrayBuffer();
});

for (const phase of ["playback:manifest", "playback:segment"]) {
  test(`create refuses a grant expiring during ${phase} verification`, async () => {
    const f = fixture(); f.onAuthorize(action => { if (action === phase) f.setMono(1000); });
    await assert.rejects(f.create(), error => error.status === 404);
    assert.equal(f.store.size, 0); assert.equal(f.allocations(), 0);
  });
  test(`renew cannot resurrect a cookie expiring during ${phase} verification`, async () => {
    const f = fixture(), session = await f.create();
    f.setExpiry(NOW + 60000);
    f.onAuthorize(action => { if (action === phase) f.setMono(1000); });
    await assert.rejects(f.store.renew(f.request(session)), error => error.status === 404);
    assert.equal(f.store.size, 0);
  });
}

for (const file of ["index.m3u8", "low/segment_1.m4s"]) {
  test(`media authorization cannot release expired ${file}`, async () => {
    const f = fixture(), session = await f.create();
    f.onAuthorize(() => f.setMono(1000));
    await assert.rejects(f.store.authorize({ ...f.request(session), method: "GET", file }), error => error.status === 404);
    assert.equal(f.store.size, 0);
  });
}
