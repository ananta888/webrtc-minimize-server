import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastPlaybackSessionError,
  BroadcastPlaybackSessionStore,
} from "../src/broadcast-playback-session-store.js";

const now = 1_800_000_000_000;
const resourceRef = "res_aaaaaaaaaaaaaaaa";

function createStore(overrides = {}) {
  const calls = [];
  let revoked = false;
  const authority = {
    async authorizeGatewayBearer(header, expectation, calledAt) {
      calls.push({ header, expectation, calledAt });
      if (!new Set(["Bearer playback-grant", "Bearer renewed-playback-grant", "Bearer wrong-device-grant", "Bearer other-principal-grant"]).has(header)
        || revoked) throw new Error("inactive_broadcast_grant");
      return {
        grantKind: "playback", resourceRef, audienceRef: header === "Bearer other-principal-grant"
          ? "sub_bbbbbbbbbbbbbbbb" : "sub_aaaaaaaaaaaaaaaa",
        tenantId: "tn_aaaaaaaaaaaaaaaa", deviceRef: header === "Bearer wrong-device-grant"
          ? "dev_bbbbbbbbbbbbbbbb" : "dev_aaaaaaaaaaaaaaaa",
        roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 2,
        policyId: "pol_aaaaaaaaaaaaaaaa", policyRevision: 3, expiresAt: calledAt + 60_000,
      };
    },
  };
  return {
    calls,
    authority,
    revoke: () => { revoked = true; },
    store: new BroadcastPlaybackSessionStore({
      authority, publicOrigin: "https://webrtc.ananta.de", monotonicClock: () => 0,
      idFactory: () => "pbs_aaaaaaaaaaaaaaaaaaaaaaaa", ...overrides,
    }),
  };
}

test("playback grant becomes a path-bound Secure HttpOnly cookie without token in URL", async () => {
  const { store, calls } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  assert.equal(session.manifestUrl, `/broadcast/play/${resourceRef}/index.m3u8`);
  assert.doesNotMatch(session.manifestUrl, /token|grant/i);
  assert.equal(session.setCookie.length, 2);
  assert.match(session.setCookie[0], /^__Secure-webrtc-broadcast-[A-Za-z0-9_-]{12}=pbs_/);
  assert.match(session.setCookie[0], new RegExp(`Path=/broadcast/play/${resourceRef}/;`));
  assert.match(session.setCookie[1], new RegExp(`Path=/api/broadcast/playback-sessions/${session.playbackSessionId};`));
  assert.ok(session.setCookie.every((value) => /Secure; HttpOnly; SameSite=Strict$/.test(value)));
  assert.equal(calls[0].expectation.action, "playback:manifest");
  assert.equal(calls[1].expectation.action, "playback:segment");
});

function pauseNextAuthorization(context, action) {
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const original = context.authority.authorizeGatewayBearer.bind(context.authority);
  let first = true;
  context.authority.authorizeGatewayBearer = async (...args) => {
    const grant = await original(...args);
    if (first && args[1].action === action) { first = false; entered(); await paused; }
    return grant;
  };
  return { ready, release };
}

for (const occupied of [false, true]) test(`renewal cannot migrate a cookie to another principal (target quota occupied: ${occupied})`, async () => {
  let sequence = 0;
  const { store } = createStore({ maximumPerAudience: 1,
    idFactory: () => `pbs_${String(++sequence).padStart(24, "a")}` });
  const origin = "https://webrtc.ananta.de";
  const first = await store.create({ authorizationHeader: "Bearer playback-grant", resourceRef, origin, now });
  if (occupied) await store.create({ authorizationHeader: "Bearer other-principal-grant", resourceRef, origin, now });
  const cookieHeader = first.setCookie[0].split(";", 1)[0];
  await assert.rejects(store.renew({ authorizationHeader: "Bearer other-principal-grant",
    sessionId: first.playbackSessionId, resourceRef, cookieHeader, origin, now: now + 1000 }), /not_found/);
  assert.equal(store.size, occupied ? 2 : 1);
  const old = await store.authorize({ cookieHeader, method: "GET", resourceRef, file: "index.m3u8", origin, now: now + 1001 });
  assert.equal(old.authorizationHeader, "Bearer playback-grant");
  if (!occupied) await store.create({ authorizationHeader: "Bearer other-principal-grant", resourceRef, origin, now: now + 1002 });
  for (const authorizationHeader of ["Bearer playback-grant", "Bearer other-principal-grant"]) {
    await assert.rejects(store.create({ authorizationHeader, resourceRef, origin, now: now + 1002 }), /quota_reached/);
  }
});

for (const ending of ["close", "prune", "replacement", "renewal"]) test(`pending renewal cannot overwrite ${ending}`, async () => {
  const context = createStore(), { store } = context;
  const origin = "https://webrtc.ananta.de";
  const session = await store.create({ authorizationHeader: "Bearer playback-grant", resourceRef, origin, now });
  const cookieHeader = session.setCookie[0].split(";", 1)[0];
  const request = { authorizationHeader: "Bearer renewed-playback-grant", sessionId: session.playbackSessionId,
    resourceRef, cookieHeader, origin, now: now + 20_000 };
  const pause = pauseNextAuthorization(context, "playback:segment");
  const pending = store.renew(request);
  const rejected = assert.rejects(pending, /not_found/);
  await pause.ready;
  if (ending === "renewal") await store.renew({ ...request, now: now + 21_000 });
  else if (ending === "prune") await assert.rejects(store.authorize({ cookieHeader, method: "GET", resourceRef,
    file: "index.m3u8", origin, now: now + 60_001 }), /not_found/);
  else {
    store.close({ sessionId: session.playbackSessionId, cookieHeader, origin, now: now + 21_000 });
    if (ending === "replacement") await store.create({ authorizationHeader: "Bearer playback-grant", resourceRef, origin, now: now + 21_000 });
  }
  pause.release();
  await rejected;
  assert.equal(store.size, ["replacement", "renewal"].includes(ending) ? 1 : 0);
});

for (const ending of ["close", "renewal"]) test(`in-flight media authorization respects ${ending}`, async () => {
  const context = createStore(), { store } = context;
  const origin = "https://webrtc.ananta.de";
  const session = await store.create({ authorizationHeader: "Bearer playback-grant", resourceRef, origin, now });
  const cookieHeader = session.setCookie[0].split(";", 1)[0];
  const pause = pauseNextAuthorization(context, "playback:manifest");
  const pending = store.authorize({ cookieHeader, method: "GET", resourceRef, file: "index.m3u8", origin, now });
  const checked = ending === "close" ? assert.rejects(pending, /not_found/) : pending;
  await pause.ready;
  if (ending === "close") store.close({ sessionId: session.playbackSessionId, cookieHeader, origin, now });
  else await store.renew({ authorizationHeader: "Bearer renewed-playback-grant", sessionId: session.playbackSessionId,
    resourceRef, cookieHeader, origin, now });
  pause.release();
  await checked;
});

test("renewal rotates only the bearer and expiry of the same cookie-, device- and epoch-bound session", async () => {
  const { store } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  const cookieHeader = session.setCookie[0].split(";", 1)[0];
  const renewed = await store.renew({
    authorizationHeader: "Bearer renewed-playback-grant", sessionId: session.playbackSessionId,
    resourceRef, cookieHeader, origin: "https://webrtc.ananta.de", now: now + 20_000,
  });
  assert.equal(renewed.playbackSessionId, session.playbackSessionId);
  assert.equal(renewed.expiresAt, now + 80_000);
  assert.equal(renewed.setCookie.length, 2);
  assert.ok(renewed.setCookie.every((value) => /Max-Age=60; Secure; HttpOnly; SameSite=Strict$/.test(value)));
  await store.authorize({
    cookieHeader, method: "GET", resourceRef, file: "index.m3u8", query: "", origin: "",
    now: now + 60_001,
  });
  await assert.rejects(store.renew({
    authorizationHeader: "Bearer wrong-device-grant", sessionId: session.playbackSessionId,
    resourceRef, cookieHeader, origin: "https://webrtc.ananta.de", now: now + 60_002,
  }), /not_found/);
});

test("every manifest and part rechecks the live grant and only permits LL-HLS query fields", async () => {
  const { store, calls } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  const cookieHeader = session.setCookie[0].split(";", 1)[0];
  const manifest = await store.authorize({
    cookieHeader, method: "GET", resourceRef, file: "index.m3u8",
    query: "_HLS_msn=42&_HLS_part=3&_HLS_skip=YES", origin: "https://webrtc.ananta.de", now,
  });
  assert.equal(manifest.upstreamPath, `/${resourceRef}/index.m3u8?_HLS_msn=42&_HLS_part=3&_HLS_skip=YES`);
  const nativeInit = await store.authorize({
    cookieHeader, method: "GET", resourceRef, file: "low/init_0.mp4",
    query: "", origin: "https://webrtc.ananta.de", now,
  });
  assert.equal(nativeInit.upstreamPath, `/${resourceRef}/low/init_0.mp4`);
  const singleRenditionInit = await store.authorize({
    cookieHeader, method: "GET", resourceRef, file: "low/init.mp4",
    query: "", origin: "https://webrtc.ananta.de", now,
  });
  assert.equal(singleRenditionInit.upstreamPath, `/${resourceRef}/low/init.mp4`);
  const part = await store.authorize({
    cookieHeader, method: "HEAD", resourceRef, file: "stream_part4.mp4",
    query: "session=75279348-f58e-4e5c-b711-39e339b3cce3", origin: "", now,
  });
  assert.equal(part.cacheControl, "private, no-store, max-age=0");
  assert.deepEqual(calls.slice(-4).map(({ expectation }) => expectation.action), [
    "playback:manifest", "playback:segment", "playback:segment", "playback:segment",
  ]);
});

test("scope, origin, traversal, token query, expiry and cookie replay fail closed as 404", async () => {
  const { store } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  const cookieHeader = session.setCookie[0].split(";", 1)[0];
  const invalid = [
    { cookieHeader, method: "GET", resourceRef, file: "../secret", query: "", origin: "" },
    { cookieHeader, method: "GET", resourceRef, file: "low/../secret", query: "", origin: "" },
    { cookieHeader, method: "GET", resourceRef, file: "unknown/init_0.mp4", query: "", origin: "" },
    { cookieHeader, method: "GET", resourceRef, file: "low/init_3.mp4", query: "", origin: "" },
    { cookieHeader, method: "POST", resourceRef, file: "index.m3u8", query: "", origin: "" },
    { cookieHeader, method: "GET", resourceRef, file: "index.m3u8", query: "token=secret", origin: "" },
    { cookieHeader, method: "GET", resourceRef, file: "index.m3u8", query: "", origin: "https://evil.test" },
    { cookieHeader, method: "GET", resourceRef: "res_bbbbbbbbbbbbbbbb", file: "index.m3u8", query: "", origin: "" },
  ];
  for (const value of invalid) {
    await assert.rejects(store.authorize({ ...value, now }), (error) => (
      error instanceof BroadcastPlaybackSessionError && error.status === 404
    ));
  }
  await assert.rejects(store.authorize({
    cookieHeader, method: "GET", resourceRef, file: "index.m3u8", query: "", origin: "", now: now + 60_001,
  }), /not_found/);
});

test("grant revocation blocks the next part even while its cookie is still valid", async () => {
  const { store, revoke } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  revoke();
  await assert.rejects(store.authorize({
    cookieHeader: session.setCookie[0].split(";", 1)[0], method: "GET", resourceRef,
    file: "video_part2.mp4", query: "", origin: "", now: now + 1,
  }), (error) => error instanceof BroadcastPlaybackSessionError
    && error.code === "broadcast_playback_not_found" && error.status === 404);
});

test("close expires the exact cookie and quotas bound active sessions", async () => {
  const { store } = createStore({ maximumPerAudience: 1 });
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  await assert.rejects(store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  }), /quota_reached/);
  const cookieHeader = session.setCookie[0].split(";", 1)[0];
  assert.throws(() => store.close({
    sessionId: session.playbackSessionId, cookieHeader: "", origin: "https://webrtc.ananta.de", now,
  }), /not_found/);
  const expired = store.close({
    sessionId: session.playbackSessionId, cookieHeader, origin: "https://webrtc.ananta.de", now,
  });
  assert.equal(expired.length, 2);
  assert.ok(expired.every((value) => /Max-Age=0; Secure; HttpOnly; SameSite=Strict$/.test(value)));
  assert.equal(store.size, 0);
  assert.throws(() => store.close({
    sessionId: session.playbackSessionId, cookieHeader, origin: "https://webrtc.ananta.de", now,
  }), /not_found/);
});
