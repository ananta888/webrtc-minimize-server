import assert from "node:assert/strict";
import test from "node:test";

import { mediaAgentScore, planMediaAgents, rankMediaAgents } from "../src/media-agent-election.js";

function candidate(id, overrides = {}) {
  return {
    id,
    ownerPeerId: `${id}-peer`,
    creatorOwned: false,
    automaticTakeover: false,
    healthy: true,
    draining: false,
    visible: true,
    battery: "mains",
    network: "fast",
    capacity: 70,
    load: 10,
    ...overrides,
  };
}

test("creator preference is a bounded election bonus and unhealthy agents stay ineligible", () => {
  const creator = candidate("creator", { creatorOwned: true, capacity: 70 });
  const fast = candidate("fast", { capacity: 100, battery: "limited", network: "normal" });
  const hidden = candidate("hidden", { creatorOwned: true, visible: false });
  const exhausted = candidate("exhausted", { capacity: 24 });
  const overloaded = candidate("overloaded", { load: 90 });
  assert.ok(mediaAgentScore(creator) > mediaAgentScore(fast));
  assert.equal(mediaAgentScore(hidden), Number.NEGATIVE_INFINITY);
  assert.equal(mediaAgentScore(exhausted), Number.NEGATIVE_INFINITY);
  assert.equal(mediaAgentScore(overloaded), Number.NEGATIVE_INFINITY);
  assert.deepEqual(
    rankMediaAgents([fast, hidden, exhausted, overloaded, creator]).map(({ id }) => id),
    ["creator", "fast"],
  );
});

test("severe load and weak network can overrule the bounded creator preference", () => {
  const overloadedCreator = candidate("creator", {
    creatorOwned: true,
    battery: "limited",
    network: "unknown",
    capacity: 0,
    load: 100,
  });
  const healthy = candidate("healthy", { capacity: 100, load: 0 });
  assert.ok(mediaAgentScore(healthy) > mediaAgentScore(overloadedCreator));
  assert.equal(rankMediaAgents([overloadedCreator, healthy])[0].id, "healthy");
});

test("initial consent elects immediately while failover can require a local takeover answer", () => {
  const creator = candidate("creator", { creatorOwned: true });
  const standby = candidate("standby");
  const initial = planMediaAgents({ candidates: [creator, standby], maxStandbys: 2 });
  assert.equal(initial.primary.id, "creator");
  assert.deepEqual(initial.standbys.map(({ id }) => id), ["standby"]);

  const awaiting = planMediaAgents({ candidates: [standby], currentPrimaryId: "creator", failover: true });
  assert.equal(awaiting.primary, null);
  assert.equal(awaiting.takeover.id, "standby");

  const approved = planMediaAgents({
    candidates: [standby],
    currentPrimaryId: "creator",
    failover: true,
    approvedAgentIds: new Set(["standby"]),
  });
  assert.equal(approved.primary.id, "standby");
});

test("automatic takeover promotes the next ranked volunteer and keeps bounded standbys", () => {
  const candidates = [
    candidate("a", { automaticTakeover: true, capacity: 80 }),
    candidate("b", { capacity: 70 }),
    candidate("c", { capacity: 60 }),
    candidate("d", { capacity: 50 }),
  ];
  const result = planMediaAgents({ candidates, currentPrimaryId: "gone", failover: true, maxStandbys: 2 });
  assert.equal(result.primary.id, "a");
  assert.deepEqual(result.standbys.map(({ id }) => id), ["b", "c"]);
});
