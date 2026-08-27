import { describe, expect, it } from "vitest";

import { validateTopologyState } from "./topology-contract";

const members = ["a", "b", "c"];
const limits = { maxChildren: 2, maxHops: 3 };
const valid = {
  version: 1,
  type: "topology-state",
  epoch: 2,
  routes: members.map((rootPeerId) => ({
    rootPeerId,
    mode: "adaptive_mesh",
    edges: [],
  })),
};

describe("topology contract", () => {
  it("accepts a closed absolute snapshot and rejects stale or incomplete epochs", () => {
    expect(validateTopologyState(valid, members, 1, limits)?.epoch).toBe(2);
    expect(validateTopologyState(valid, members, 2, limits)).toBeNull();
    expect(validateTopologyState({ ...valid, routes: valid.routes.slice(1) }, members, 1, limits)).toBeNull();
    expect(validateTopologyState({ ...valid, extra: true }, members, 1, limits)).toBeNull();
  });

  it("rejects cycles, duplicate children and excessive fanout", () => {
    const route = {
      rootPeerId: "a",
      mode: "trusted_peer_relay",
      edges: [
        { parentPeerId: "b", childPeerId: "c", depth: 1 },
        { parentPeerId: "c", childPeerId: "b", depth: 2 },
      ],
    };
    expect(validateTopologyState({
      ...valid,
      routes: [route, valid.routes[1], valid.routes[2]],
    }, members, 1, limits)).toBeNull();
  });
});
