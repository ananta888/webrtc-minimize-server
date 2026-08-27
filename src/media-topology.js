export const TOPOLOGY_MODES = Object.freeze(["adaptive_mesh", "trusted_peer_relay"]);

function normalizedPeerIds(peers) {
  return [...new Set(peers.map((peer) => peer.id))].sort();
}

export function buildRelayTree(peerIds, rootPeerId, eligibleRelayIds, options = {}) {
  const maxChildren = options.maxChildren ?? 3;
  const maxHops = options.maxHops ?? 3;
  const peers = [...new Set(peerIds)].sort();
  if (!peers.includes(rootPeerId)) throw new Error("topology_root_missing");
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 2 || maxChildren > 5) {
    throw new Error("invalid_topology_max_children");
  }
  if (!Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > 4) {
    throw new Error("invalid_topology_max_hops");
  }

  const eligible = new Set(eligibleRelayIds.filter((peerId) => peers.includes(peerId)));
  eligible.delete(rootPeerId);
  const remaining = peers
    .filter((peerId) => peerId !== rootPeerId)
    .sort((left, right) => Number(eligible.has(right)) - Number(eligible.has(left)) || left.localeCompare(right));
  const parents = [{ peerId: rootPeerId, depth: 0, children: 0 }];
  const edges = [];

  while (remaining.length > 0) {
    const parent = parents.find((candidate) => (
      candidate.depth < maxHops && candidate.children < maxChildren
    ));
    if (!parent) return null;
    const childPeerId = remaining.shift();
    const depth = parent.depth + 1;
    edges.push(Object.freeze({ parentPeerId: parent.peerId, childPeerId, depth }));
    parent.children += 1;
    if (eligible.has(childPeerId) && depth < maxHops) {
      parents.push({ peerId: childPeerId, depth, children: 0 });
    }
  }
  return Object.freeze(edges);
}

export function buildRoomTopology(peers, epoch, options = {}) {
  const enabled = options.enabled ?? true;
  const minimumParticipants = options.minimumParticipants ?? 6;
  const peerIds = normalizedPeerIds(peers);
  const eligible = peers.filter((peer) => peer.relayConsent === true).map((peer) => peer.id);
  const routes = peerIds.map((rootPeerId) => {
    const edges = enabled && peerIds.length >= minimumParticipants
      ? buildRelayTree(peerIds, rootPeerId, eligible, options)
      : null;
    return Object.freeze({
      rootPeerId,
      mode: edges ? "trusted_peer_relay" : "adaptive_mesh",
      edges: edges || [],
    });
  });
  return Object.freeze({
    type: "topology-state",
    epoch,
    routes: Object.freeze(routes),
  });
}
