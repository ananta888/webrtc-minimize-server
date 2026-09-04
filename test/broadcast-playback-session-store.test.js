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
      if (header !== "Bearer playback-grant" || revoked) throw new Error("inactive_broadcast_grant");
      return {
        grantKind: "playback", resourceRef, audienceRef: "sub_aaaaaaaaaaaaaaaa", expiresAt: now + 60_000,
      };
    },
  };
  return {
    calls,
    revoke: () => { revoked = true; },
    store: new BroadcastPlaybackSessionStore({
      authority, publicOrigin: "https://webrtc.ananta.de",
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
  assert.match(session.setCookie, /^__Secure-webrtc-broadcast-[A-Za-z0-9_-]{12}=pbs_/);
  assert.match(session.setCookie, /Secure; HttpOnly; SameSite=Strict$/);
  assert.equal(calls[0].expectation.action, "playback:manifest");
  assert.equal(calls[1].expectation.action, "playback:segment");
});

test("every manifest and part rechecks the live grant and only permits LL-HLS query fields", async () => {
  const { store, calls } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  const cookieHeader = session.setCookie.split(";", 1)[0];
  const manifest = await store.authorize({
    cookieHeader, method: "GET", resourceRef, file: "index.m3u8",
    query: "_HLS_msn=42&_HLS_part=3&_HLS_skip=YES", origin: "https://webrtc.ananta.de", now,
  });
  assert.equal(manifest.upstreamPath, `/${resourceRef}/index.m3u8?_HLS_msn=42&_HLS_part=3&_HLS_skip=YES`);
  const part = await store.authorize({
    cookieHeader, method: "HEAD", resourceRef, file: "stream_part4.mp4",
    query: "session=75279348-f58e-4e5c-b711-39e339b3cce3", origin: "", now,
  });
  assert.equal(part.cacheControl, "private, no-store, max-age=0");
  assert.equal(calls.at(-2).expectation.action, "playback:manifest");
  assert.equal(calls.at(-1).expectation.action, "playback:segment");
});

test("scope, origin, traversal, token query, expiry and cookie replay fail closed as 404", async () => {
  const { store } = createStore();
  const session = await store.create({
    authorizationHeader: "Bearer playback-grant", resourceRef,
    origin: "https://webrtc.ananta.de", now,
  });
  const cookieHeader = session.setCookie.split(";", 1)[0];
  const invalid = [
    { cookieHeader, method: "GET", resourceRef, file: "../secret", query: "", origin: "" },
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
    cookieHeader: session.setCookie.split(";", 1)[0], method: "GET", resourceRef,
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
  const cookieHeader = session.setCookie.split(";", 1)[0];
  assert.throws(() => store.close({
    sessionId: session.playbackSessionId, cookieHeader: "", origin: "https://webrtc.ananta.de", now,
  }), /not_found/);
  const expired = store.close({
    sessionId: session.playbackSessionId, cookieHeader, origin: "https://webrtc.ananta.de", now,
  });
  assert.match(expired, /Max-Age=0; Secure; HttpOnly; SameSite=Strict$/);
  assert.equal(store.size, 0);
  assert.throws(() => store.close({
    sessionId: session.playbackSessionId, cookieHeader, origin: "https://webrtc.ananta.de", now,
  }), /not_found/);
});
