import { describe, expect, it } from "vitest";

import { validateTopologyState } from "./topology-contract";

const members = ["a", "b", "c"];
const limits = { maxChildren: 2, maxHops: 3 };
const valid = {
  version: 1,
  type: "topology-state",
  membershipEpoch: 1,
  routeEpoch: 2,
  topologyEpoch: 2,
  leaseExpiresAt: Date.now() + 60_000,
  peers: members,
  routes: members.map((rootPeerId) => ({
    rootPeerId,
    scopeId: `video:${rootPeerId}`,
    mode: "adaptive_mesh",
    edges: [],
  })),
};

describe("topology contract", () => {
  it("accepts a closed absolute snapshot and rejects stale or incomplete epochs", () => {
    expect(validateTopologyState(valid, members, 1, limits)?.topologyEpoch).toBe(2);
    expect(validateTopologyState(valid, members, 2, limits)).toBeNull();
    expect(validateTopologyState({ ...valid, routes: valid.routes.slice(1) }, members, 1, limits)).toBeNull();
    expect(validateTopologyState({ ...valid, extra: true }, members, 1, limits)).toBeNull();
  });

  it("rejects cycles, duplicate children and excessive fanout", () => {
    const route = {
      rootPeerId: "a",
      scopeId: "video:a",
      mode: "trusted_peer_relay",
      edges: [
        { leaseId: "AAAAAAAAAAAAAAAAAAAAAA", parentPeerId: "b", backupParentPeerId: null, childPeerId: "c", depth: 1, expiresAt: valid.leaseExpiresAt },
        { leaseId: "BBBBBBBBBBBBBBBBBBBBBB", parentPeerId: "c", backupParentPeerId: null, childPeerId: "b", depth: 2, expiresAt: valid.leaseExpiresAt },
      ],
    };
    expect(validateTopologyState({
      ...valid,
      routes: [route, valid.routes[1], valid.routes[2]],
    }, members, 1, limits)).toBeNull();
  });

  it("rejects regressed membership/routes and expired or mismatched leases", () => {
    expect(validateTopologyState(valid, members, 1, limits, 2, 1)).toBeNull();
    expect(validateTopologyState(valid, members, 1, limits, 1, 2)).toBeNull();
    expect(validateTopologyState({ ...valid, leaseExpiresAt: Date.now() - 1 }, members, 1, limits)).toBeNull();
    expect(validateTopologyState({ ...valid, peers: ["a", "b", "outsider"] }, members, 1, limits)).toBeNull();
  });
});
