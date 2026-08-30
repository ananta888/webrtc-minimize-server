import assert from "node:assert/strict";
import test from "node:test";

import { RelayHealthTracker } from "../src/relay-health.js";

const bad = Object.freeze({
  relayPeerId: "aaaaaaaaaaaaaaaa",
  routeEpoch: 3,
  sampleCount: 8,
  deliveryRatio: 0.5,
  delayMs: 4_000,
  observedCapacity: 20,
});

test("RelayHealthTracker needs two observers and room majority", () => {
  const tracker = new RelayHealthTracker({ windowMs: 1000, cooldownMs: 2000 });
  assert.equal(tracker.observe("room", "one", bad, 4, 100), false);
  assert.equal(tracker.blockedRelayIds("room", 100).size, 0);
  assert.equal(tracker.observe("room", "two", bad, 4, 101), true);
  assert.deepEqual([...tracker.blockedRelayIds("room", 102)], [bad.relayPeerId]);
  assert.equal(tracker.blockedRelayIds("room", 2102).size, 0);
});

test("RelayHealthTracker ignores insufficient samples, healthy reports and stale observations", () => {
  const tracker = new RelayHealthTracker({ windowMs: 100, cooldownMs: 1000 });
  assert.equal(tracker.observe("room", "one", { ...bad, sampleCount: 2 }, 3, 0), false);
  assert.equal(tracker.observe("room", "two", { ...bad, deliveryRatio: 1, delayMs: 10 }, 3, 1), false);
  assert.equal(tracker.observe("room", "three", bad, 3, 200), false);
});

test("RelayHealthTracker cleans observer, relay and room state", () => {
  const tracker = new RelayHealthTracker();
  tracker.observe("room", "one", bad, 3, 0);
  tracker.leave("room", "one");
  assert.equal(tracker.observe("room", "two", bad, 3, 1), false);
  tracker.removeRoom("room");
  assert.equal(tracker.blockedRelayIds("room").size, 0);
});
