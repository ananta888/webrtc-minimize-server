import assert from "node:assert/strict";
import test from "node:test";

import {
  CDN_HLS_PROFILE,
  createPublicCdnCachePolicy,
  ORIGIN_LLHLS_PROFILE,
  selectBroadcastDeliveryProfile,
} from "../src/broadcast-delivery-profile-policy.js";

const cdn = {
  enabled: false, runtimeVerified: false, originAuthenticated: false, hostAllowed: false,
  pathAllowed: false, shielding: false, purgeReady: false, cacheKeyVersion: 1,
  maximumViewers: 10_000, healthy: false,
};

test("measured origin profile admits only its verified local viewer envelope", () => {
  assert.equal(ORIGIN_LLHLS_PROFILE.maximumViewers, 20);
  assert.equal(ORIGIN_LLHLS_PROFILE.maximumBlockingReloads, 20);
  assert.equal(ORIGIN_LLHLS_PROFILE.endToGlassLatencyVerified, false);
  const selected = selectBroadcastDeliveryProfile({
    visibility: "private", expectedViewers: 20, originHealthy: true, currentProfileId: null, cdn,
  });
  assert.equal(selected.profile.profileId, ORIGIN_LLHLS_PROFILE.profileId);
  assert.equal(selected.transition, "none");
  assert.throws(() => selectBroadcastDeliveryProfile({
    visibility: "private", expectedViewers: 21, originHealthy: true, currentProfileId: null, cdn,
  }), /capacity_exhausted/);
});

test("CDN is public-only, fully capability-gated and switches with a visible restart", () => {
  const ready = Object.fromEntries(Object.entries(cdn).map(([key, value]) => [
    key, typeof value === "boolean" ? true : value,
  ]));
  const selected = selectBroadcastDeliveryProfile({
    visibility: "public", expectedViewers: 500, originHealthy: true,
    currentProfileId: ORIGIN_LLHLS_PROFILE.profileId, cdn: ready,
  });
  assert.equal(selected.profile, CDN_HLS_PROFILE);
  assert.equal(selected.transition, "visible-short-restart");
  assert.throws(() => selectBroadcastDeliveryProfile({
    visibility: "private", expectedViewers: 500, originHealthy: true,
    currentProfileId: ORIGIN_LLHLS_PROFILE.profileId, cdn: ready,
  }), /capacity_exhausted/);
  assert.throws(() => selectBroadcastDeliveryProfile({
    visibility: "public", expectedViewers: 500, originHealthy: true,
    currentProfileId: null, cdn: { ...ready, purgeReady: false },
  }), /capacity_exhausted/);
});

test("public CDN cache keys are host, resource and epoch bound without query credentials", () => {
  const policy = createPublicCdnCachePolicy({
    host: "cdn.ananta.de", pathPrefix: "/broadcast/public/res_aaaaaaaaaaaaaaaa/",
    programEpoch: 7, originSecret: "a".repeat(32),
  });
  assert.equal(policy.cacheKey, "cdn.ananta.de/broadcast/public/res_aaaaaaaaaaaaaaaa/epoch-7/{object}");
  assert.equal(policy.shieldingRequired, true);
  assert.doesNotMatch(JSON.stringify(policy), /a{32}/);
  assert.throws(() => createPublicCdnCachePolicy({
    host: "evil.test/path", pathPrefix: "/broadcast/public/res_aaaaaaaaaaaaaaaa/",
    programEpoch: 7, originSecret: "a".repeat(32),
  }), /invalid_public_cdn_policy/);
});
