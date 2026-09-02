import assert from "node:assert/strict";
import test from "node:test";

import { buildRelayTree, buildRoomTopology, isEligibleRelay } from "../src/media-topology.js";

test("buildRelayTree is deterministic, bounded and cycle free", () => {
  const peers = ["d", "a", "f", "b", "e", "c"];
  const routeOptions = { maxChildren: 2, maxHops: 3, routeEpoch: 4, expiresAt: 50_000 };
  const first = buildRelayTree(peers, "a", ["b", "c"], routeOptions);
  const second = buildRelayTree([...peers].reverse(), "a", ["c", "b"], routeOptions);
  assert.deepEqual(first, second);
  assert.equal(first.length, peers.length - 1);
  const parents = new Map();
  for (const edge of first) {
    assert.ok(edge.depth >= 1 && edge.depth <= 3);
    assert.match(edge.leaseId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(edge.expiresAt, 50_000);
    assert.equal(parents.has(edge.childPeerId), false);
    parents.set(edge.childPeerId, edge.parentPeerId);
  }
  for (const peerId of peers.filter((peer) => peer !== "a")) {
    const seen = new Set([peerId]);
    let current = peerId;
    while (current !== "a") {
      current = parents.get(current);
      assert.ok(current);
      assert.equal(seen.has(current), false);
      seen.add(current);
    }
  }
});

test("room topology requires policy, room size and enough consenting relays", () => {
  const peers = Array.from({ length: 6 }, (_, index) => ({
    id: `peer-${index}`,
    relayConsent: index === 1 || index === 2,
  }));
  const topology = buildRoomTopology(peers, { membership: 5, route: 7, topology: 9 }, {
    enabled: true, minimumParticipants: 6, maxChildren: 3, maxHops: 3, now: 1000, leaseMs: 60_000,
  });
  assert.equal(topology.membershipEpoch, 5);
  assert.equal(topology.routeEpoch, 7);
  assert.equal(topology.topologyEpoch, 9);
  assert.equal(topology.leaseExpiresAt, 61_000);
  assert.deepEqual(topology.peers, peers.map((peer) => peer.id).sort());
  assert.ok(topology.routes.every((route) => route.scopeId === `video:${route.rootPeerId}`));
  assert.ok(topology.routes.every((route) => route.mode === "trusted_peer_relay"));
  assert.ok(topology.routes.every((route) => route.edges.length === 5));
  const disabled = buildRoomTopology(peers, 8, { enabled: false, minimumParticipants: 6 });
  assert.ok(disabled.routes.every((route) => route.mode === "adaptive_mesh" && route.edges.length === 0));
});

test("small-room browser relays activate only when their bound reduces publisher fanout", () => {
  const peers = Array.from({ length: 6 }, (_, index) => ({
    id: `peer-${index}`,
    relayConsent: true,
    relayCapability: {
      visible: true,
      battery: "mains",
      network: "fast",
      selfCapacity: 90,
      observedCapacity: 90,
      deliveryRatio: 1,
    },
  }));
  const options = {
    enabled: true,
    minimumParticipants: 3,
    maxChildren: 3,
    maxHops: 3,
    now: 1_000,
    leaseMs: 60_000,
  };

  for (const participantCount of [3, 4]) {
    const direct = buildRoomTopology(peers.slice(0, participantCount), participantCount, options);
    assert.ok(direct.routes.every((route) => (
      route.mode === "adaptive_mesh" && route.edges.length === 0
    )));
  }
  for (const participantCount of [5, 6]) {
    const relayed = buildRoomTopology(peers.slice(0, participantCount), participantCount, options);
    assert.ok(relayed.routes.every((route) => route.mode === "trusted_peer_relay"));
    assert.ok(relayed.routes.every((route) => (
      route.edges.filter((edge) => edge.parentPeerId === route.rootPeerId).length === 3
    )));
  }

  const boundedAtTwo = buildRoomTopology(peers.slice(0, 4), 4, { ...options, maxChildren: 2 });
  assert.ok(boundedAtTwo.routes.every((route) => route.mode === "trusted_peer_relay"));
  assert.ok(boundedAtTwo.routes.every((route) => (
    route.edges.filter((edge) => edge.parentPeerId === route.rootPeerId).length === 2
  )));
});

test("relay eligibility is conservative and respects observed capacity and cooldown", () => {
  const base = {
    id: "relay",
    relayConsent: true,
    relayCapability: {
      visible: true,
      battery: "mains",
      network: "fast",
      selfCapacity: 90,
      observedCapacity: 80,
      deliveryRatio: 0.95,
    },
  };
  assert.equal(isEligibleRelay(base), true);
  assert.equal(isEligibleRelay({ ...base, relayCapability: { ...base.relayCapability, visible: false } }), false);
  assert.equal(isEligibleRelay({ ...base, relayCapability: { ...base.relayCapability, battery: "critical" } }), false);
  assert.equal(isEligibleRelay({ ...base, relayCapability: { ...base.relayCapability, observedCapacity: 20 } }), false);
  assert.equal(isEligibleRelay(base, new Set(["relay"])), false);
});

test("relay tree returns null rather than exceeding bounded fanout", () => {
  const peers = Array.from({ length: 20 }, (_, index) => `peer-${String(index).padStart(2, "0")}`);
  assert.equal(buildRelayTree(peers, peers[0], [], { maxChildren: 3, maxHops: 3 }), null);
});
