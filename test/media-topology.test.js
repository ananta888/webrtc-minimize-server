import assert from "node:assert/strict";
import test from "node:test";

import { buildRelayTree, buildRoomTopology } from "../src/media-topology.js";

test("buildRelayTree is deterministic, bounded and cycle free", () => {
  const peers = ["d", "a", "f", "b", "e", "c"];
  const first = buildRelayTree(peers, "a", ["b", "c"], { maxChildren: 2, maxHops: 3 });
  const second = buildRelayTree([...peers].reverse(), "a", ["c", "b"], { maxChildren: 2, maxHops: 3 });
  assert.deepEqual(first, second);
  assert.equal(first.length, peers.length - 1);
  const parents = new Map();
  for (const edge of first) {
    assert.ok(edge.depth >= 1 && edge.depth <= 3);
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
  const topology = buildRoomTopology(peers, 7, {
    enabled: true, minimumParticipants: 6, maxChildren: 3, maxHops: 3,
  });
  assert.equal(topology.epoch, 7);
  assert.ok(topology.routes.every((route) => route.mode === "trusted_peer_relay"));
  assert.ok(topology.routes.every((route) => route.edges.length === 5));
  const disabled = buildRoomTopology(peers, 8, { enabled: false, minimumParticipants: 6 });
  assert.ok(disabled.routes.every((route) => route.mode === "adaptive_mesh" && route.edges.length === 0));
});

test("relay tree returns null rather than exceeding bounded fanout", () => {
  const peers = Array.from({ length: 20 }, (_, index) => `peer-${String(index).padStart(2, "0")}`);
  assert.equal(buildRelayTree(peers, peers[0], [], { maxChildren: 3, maxHops: 3 }), null);
});
