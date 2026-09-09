import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { BroadcastPlaybackSessionStore } from "../src/broadcast-playback-session-store.js";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";
import { BroadcastAbuseGuard } from "../src/broadcast-admission-control.js";

const resourceRef = "res_aaaaaaaaaaaaaaaa", origin = "https://synthetic-playback.example.test";
function fixture() {
  let revoked = false, forwarded = 0, authorizations = 0;
  const sessions = new BroadcastPlaybackSessionStore({ publicOrigin: origin, authority: {
    async authorizeGatewayBearer(header, expectation, now) {
      authorizations++;
      if (revoked || header !== "Bearer synthetic" || expectation.path !== `/broadcast/play/${resourceRef}`) throw new Error("denied");
      return { grantKind: "playback", resourceRef, audienceRef: "aud_synthetic", expiresAt: now + 60000 };
    },
  } });
  const proxy = new BroadcastHlsProxy({ sessions, gatewayOrigin: "http://127.0.0.1:9", fetchImpl: async () => {
    forwarded++; return new Response("#EXTM3U\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  } });
  return { sessions, proxy, revoke: () => { revoked = true; }, counts: () => ({ forwarded, authorizations }),
    create: () => sessions.create({ origin, resourceRef, authorizationHeader: "Bearer synthetic" }) };
}

test("real HTTP HLS traffic uses owned session budgets rather than the 30-per-IP probe bucket", async t => {
  const f = fixture(), one = await f.create(), two = await f.create();
  const app = createAppServer({ config: { publicOrigin: origin, authMode: "disabled", stunUrls: [], turnServers: [] },
    broadcastPlaybackSessions: f.sessions, broadcastHlsProxy: f.proxy });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
      for (const socket of server.clients) socket.terminate();
    }
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  const url = `http://127.0.0.1:${app.server.address().port}${one.manifestUrl}`;
  const cookie = s => s.setCookie[0].split(";", 1)[0];
  const get = async value => {
    const response = await fetch(url, { headers: { ...(value ? { cookie: value } : {}), origin } });
    await response.arrayBuffer(); return response.status;
  };
  for (let i = 0; i < 90; i++) assert.equal(await get(cookie(one)), 200, `normal segment/playlist request ${i + 1}`);
  assert.equal(f.counts().forwarded, 90);
  assert.equal(await get(cookie(one).replace(/^.*=/, "__Secure-webrtc-broadcast-wrongname123=")), 404);
  for (let i = 0; i < 29; i++) assert.equal(await get(""), 404);
  assert.equal(await get(""), 429, "unknown probes remain IP-bounded");
  assert.equal(await get(cookie(two)), 200, "a second viewer behind the same IP has an independent known session");
  assert.equal(await get(cookie(one)), 200);
  const before = f.counts(); f.revoke();
  assert.equal(await get(cookie(one)), 404, "rate classification cannot bypass current grant authorization");
  assert.equal(f.counts().forwarded, before.forwarded);
  assert.ok(f.counts().authorizations > before.authorizations);
});

test("playback-media has a finite separate per-session allowance without weakening unknown probes", () => {
  const guard = new BroadcastAbuseGuard({ key: Buffer.alloc(32, 7) });
  try {
    for (let i = 0; i < 1200; i++) assert.equal(guard.allow({ action: "playback-media", actorRef: "pbs_session_a", now: 1000 }), true);
    assert.equal(guard.allow({ action: "playback-media", actorRef: "pbs_session_a", now: 1000 }), false);
    assert.equal(guard.allow({ action: "playback-media", actorRef: "pbs_session_b", now: 1000 }), true);
    for (let i = 0; i < 30; i++) assert.equal(guard.allow({ action: "playback-probe", actorRef: "127.0.0.1", now: 1000 }), true);
    assert.equal(guard.allow({ action: "playback-probe", actorRef: "127.0.0.1", now: 1000 }), false);
  } finally { guard.destroy(); }
});

test("rate identity requires the exact current local cookie and resource, and never authorizes media", async () => {
  const f = fixture(), session = await f.create(), now = Date.now();
  const input = { cookieHeader: session.setCookie[0].split(";", 1)[0], resourceRef, origin, method: "GET", file: "index.m3u8", now };
  const before = f.counts();
  assert.equal(f.sessions.rateLimitKey(input), session.playbackSessionId);
  assert.deepEqual(f.counts(), before, "lookup does no network or grant verification");
  for (const change of [{ cookieHeader: "" }, { resourceRef: "res_bbbbbbbbbbbbbbbb" }, { origin: "https://foreign.test" },
    { file: "../private" }, { method: "POST" }, { query: "?token=unknown" },
    { cookieHeader: input.cookieHeader.replace(/^.*=/, "__Secure-webrtc-broadcast-wrongname123=") }]) {
    assert.equal(f.sessions.rateLimitKey({ ...input, ...change }), null);
  }
  f.revoke(); assert.equal(f.sessions.rateLimitKey(input), session.playbackSessionId);
  await assert.rejects(f.sessions.authorize(input), /not_found/);
  f.sessions.close({ sessionId: session.playbackSessionId, cookieHeader: input.cookieHeader, origin, now });
  assert.equal(f.sessions.rateLimitKey(input), null);
});
