import { afterEach, describe, expect, it, vi } from "vitest";

import { PeerTopologyController } from "./peer-topology-controller";
import { TrustedRelayController } from "./trusted-relay-controller";

const peers = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];

function snapshot(expiresAt: number) {
  return {
    version: 1,
    type: "topology-state",
    membershipEpoch: 1,
    routeEpoch: 1,
    topologyEpoch: 1,
    leaseExpiresAt: expiresAt,
    peers,
    routes: peers.map((rootPeerId) => ({
      rootPeerId,
      scopeId: `video:${rootPeerId}`,
      mode: rootPeerId === peers[0] ? "trusted_peer_relay" : "adaptive_mesh",
      edges: rootPeerId === peers[0] ? [
        { leaseId: "AAAAAAAAAAAAAAAAAAAAAA", parentPeerId: peers[0], backupParentPeerId: null, childPeerId: peers[1], depth: 1, expiresAt },
        { leaseId: "BBBBBBBBBBBBBBBBBBBBBB", parentPeerId: peers[1], backupParentPeerId: peers[0], childPeerId: peers[2], depth: 2, expiresAt },
      ] : [],
    })),
  };
}

describe("peer topology and trusted relay controllers", () => {
  afterEach(() => vi.useRealTimers());

  it("materializes paths and expires relay authority locally", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const expired = vi.fn();
    const topology = new PeerTopologyController(expired);
    expect(topology.apply(snapshot(61_000), peers, { maxChildren: 3, maxHops: 3 })).not.toBeNull();
    expect(topology.path(peers[0], peers[2])).toEqual(peers);
    expect(topology.children(peers[0], peers[1]).has(peers[2])).toBe(true);
    expect(topology.analysisEdges()).toEqual([
      { rootPeerId: peers[0], parentPeerId: peers[0], childPeerId: peers[1] },
      { rootPeerId: peers[0], parentPeerId: peers[1], childPeerId: peers[2] },
    ]);
    vi.advanceTimersByTime(60_001);
    expect(expired).toHaveBeenCalledOnce();
    expect(topology.mode(peers[0])).toBe("adaptive_mesh");
    expect(topology.analysisEdges()).toEqual([]);
  });

  it("allows only the materialized video fanout while audio remains direct", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const topology = new PeerTopologyController(() => undefined);
    topology.apply(snapshot(61_000), peers, { maxChildren: 3, maxHops: 3 });
    const relay = new TrustedRelayController(topology);
    expect(relay.shouldSend({ trackKind: "video", publicationLocal: true, rootPeerId: peers[0], ownPeerId: peers[0], targetPeerId: peers[1] })).toBe(true);
    expect(relay.shouldSend({ trackKind: "video", publicationLocal: true, rootPeerId: peers[0], ownPeerId: peers[0], targetPeerId: peers[2] })).toBe(false);
    expect(relay.shouldSend({ trackKind: "audio", publicationLocal: true, rootPeerId: peers[0], ownPeerId: peers[0], targetPeerId: peers[2] })).toBe(true);
    topology.clear();
  });
});
