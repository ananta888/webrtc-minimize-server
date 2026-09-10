import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createAppServer } from "../src/server.js";
import { BroadcastPlaybackSessionStore } from "../src/broadcast-playback-session-store.js";

test("ENV budgets reach the production proxy and terminate excess HTTP bodies without affecting health or auth", async t => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests++;
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    response.end("#EXTM3U\n");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const origin = "https://synthetic-playback.example.test", resourceRef = "res_aaaaaaaaaaaaaaaa";
  const sessions = new BroadcastPlaybackSessionStore({ publicOrigin: origin, authority: {
    async authorizeGatewayBearer(header, expectation, now) {
      assert.equal(header, "Bearer synthetic"); assert.equal(expectation.path, `/broadcast/play/${resourceRef}`);
      return { grantKind: "playback", resourceRef, audienceRef: "sub_aaaaaaaaaaaaaaaa",
        tenantId: "tn_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa", expiresAt: now + 60000 };
    },
  } });
  const one = await sessions.create({ origin, resourceRef, authorizationHeader: "Bearer synthetic" });
  const two = await sessions.create({ origin, resourceRef, authorizationHeader: "Bearer synthetic" });
  const config = loadConfig({ PUBLIC_ORIGIN: origin, AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false",
    BROADCAST_GATEWAY_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
    BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND: "1", BROADCAST_HLS_EGRESS_BURST_BYTES: "8" });
  // Deliberately do not inject a proxy: exercise actual server construction.
  const app = createAppServer({ config, broadcastPlaybackSessions: sessions });
  t.after(async () => {
    for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
      for (const socket of server.clients) socket.terminate();
    }
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const read = async session => {
    const response = await fetch(base + one.manifestUrl, { headers: { origin,
      cookie: session.setCookie[0].split(";", 1)[0] }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.text();
  };
  assert.equal(await read(one), "#EXTM3U\n");
  await assert.rejects(read(two), /fetch failed|terminated|socket|aborted/i);
  assert.equal(upstreamRequests, 2);
  const missing = await fetch(base + one.manifestUrl, { headers: { origin }, signal: AbortSignal.timeout(5000) });
  assert.equal(missing.status, 404); await missing.arrayBuffer();
  assert.equal(upstreamRequests, 2);
  const health = await fetch(base + "/healthz", { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200); await health.arrayBuffer();
});
