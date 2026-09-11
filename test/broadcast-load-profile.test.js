import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBroadcastLoadProfile } from "../src/broadcast-load-profile.js";

const valid = () => ({
  profileId: "origin-llhls-local-v1", delivery: "origin-llhls", publishers: 1, roomMembers: 20,
  originViewers: 20, codec: "h264-aac", renditions: 3, durationSeconds: 15, runtimeVerified: false,
});

test("load profiles are origin-only planning envelopes and cannot claim verification", () => {
  const profile = normalizeBroadcastLoadProfile(valid());
  assert.equal(profile.runtimeVerified, false);
  assert.equal(profile.delivery, "origin-llhls");
  assert.throws(() => normalizeBroadcastLoadProfile({ ...valid(), runtimeVerified: true }), /invalid_broadcast_load_profile/);
  assert.throws(() => normalizeBroadcastLoadProfile({ ...valid(), delivery: "cdn-standard-hls" }), /invalid_broadcast_load_profile/);
  assert.throws(() => normalizeBroadcastLoadProfile({ ...valid(), originViewers: 51 }), /invalid_broadcast_load_profile/);
  assert.throws(() => normalizeBroadcastLoadProfile({ ...valid(), roomMembers: 21 }), /invalid_broadcast_load_profile/);
  assert.throws(() => normalizeBroadcastLoadProfile({ ...valid(), extra: true }), /invalid_broadcast_load_profile/);
});
