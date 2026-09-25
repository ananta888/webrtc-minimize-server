import assert from "node:assert/strict";
import test from "node:test";

import { issueIcePolicy } from "../src/ice-policy.js";
import { IceRefreshError, IceRefreshGrantStore } from "../src/ice-refresh-grants.js";

const claims = { turnPrincipal: "issuer|subject", turnNotAfter: 0, origin: "https://meet.test" };

function rejects(fn, code, status) {
  assert.throws(fn, (error) => error instanceof IceRefreshError && error.code === code && error.status === status);
}

test("ICE refresh grants are redeemable only while their bound membership is live", () => {
  const store = new IceRefreshGrantStore({ bindTtlMs: 1_000 });
  const token = store.issue(claims, 0);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  rejects(() => store.redeem(token, { origin: "https://meet.test", now: 1 }), "invalid_ice_refresh", 401);
  let live = true;
  assert.equal(store.bind(token, () => live), true);
  assert.equal(store.bind(token, () => true), false, "a grant binds exactly once");
  assert.deepEqual(store.redeem(token, { origin: "https://meet.test", now: 2 }), claims);
  rejects(() => store.redeem(token, { origin: "https://evil.test", now: 3 }), "ice_refresh_origin_mismatch", 403);
  live = false;
  rejects(() => store.redeem(token, { origin: "https://meet.test", now: 4 }), "invalid_ice_refresh", 401);
  assert.equal(store.size, 0, "a dead membership drops its grant");
});

test("ICE refresh grants reject malformed, unknown and revoked tokens", () => {
  const store = new IceRefreshGrantStore();
  for (const token of [undefined, "", 42, "short", "x".repeat(44), `${"a".repeat(42)}!`]) {
    rejects(() => store.redeem(token), "invalid_ice_refresh", 401);
  }
  rejects(() => store.redeem("a".repeat(43)), "invalid_ice_refresh", 401);
  const token = store.issue(claims);
  store.bind(token, () => true);
  store.revoke(token);
  rejects(() => store.redeem(token), "invalid_ice_refresh", 401);
});

test("ICE refresh grants rate-limit a burst per window and prune unbound or dead grants", () => {
  const store = new IceRefreshGrantStore({ bindTtlMs: 100, maxPerWindow: 2, windowMs: 1_000 });
  const token = store.issue(claims, 0);
  store.bind(token, () => true);
  store.redeem(token, { now: 10 });
  store.redeem(token, { now: 20 });
  rejects(() => store.redeem(token, { now: 30 }), "rate_limited", 429);
  assert.deepEqual(store.redeem(token, { now: 1_010 }), claims, "a new window admits again");
  const unbound = store.issue(claims, 0);
  const dead = store.issue(claims, 0);
  store.bind(dead, () => false);
  store.prune(50);
  assert.equal(store.size, 2, "an unbound grant survives until its bind deadline");
  store.prune(101);
  assert.equal(store.size, 1);
  rejects(() => store.redeem(unbound, { now: 102 }), "invalid_ice_refresh", 401);
});

test("issueIcePolicy reports the earliest TURN expiry and none without ephemeral credentials", () => {
  const config = {
    stunUrls: ["stun:stun.test:3478"],
    turnServers: [],
    turnUrls: ["turn:turn.test:3478?transport=udp"],
    turnSharedSecret: "test-secret",
    turnCredentialTtlMs: 3_600_000,
    edgeTurnServers: [{ id: "edge", urls: ["turn:edge.test:3478"], sharedSecret: "e".repeat(32), realm: "edge.test" }],
    peerEdgeFallbackMs: 4_000,
    infrastructureTurnFallbackMs: 9_000,
  };
  const issued = issueIcePolicy(config, "issuer|subject", { now: 1_000_000 });
  assert.equal(issued.icePolicy.infrastructureRelayIceServers[0].username.split(":")[0], "4600");
  assert.equal(issued.credentialsExpireAt, 1_600_000, "the Edge credential is capped at ten minutes");
  assert.deepEqual(issued.issued, { peerEdge: 1, infrastructure: 1 });
  assert.equal(issued.iceServers.length, 3);
  const direct = issueIcePolicy({ ...config, turnSharedSecret: "", edgeTurnServers: [] }, "issuer|subject");
  assert.equal(direct.credentialsExpireAt, null);
  assert.deepEqual(direct.icePolicy.infrastructureRelayIceServers, []);
});
