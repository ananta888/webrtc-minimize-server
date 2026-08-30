import crypto from "node:crypto";

export const TOPOLOGY_MODES = Object.freeze(["adaptive_mesh", "trusted_peer_relay"]);

const BATTERY_RANK = Object.freeze({ critical: 0, unknown: 1, limited: 2, mains: 3 });
const NETWORK_RANK = Object.freeze({ constrained: 0, unknown: 1, normal: 2, fast: 3 });

function normalizedPeerIds(peers) {
  return [...new Set(peers.map((peer) => peer.id))].sort();
}

function capabilityOf(peer) {
  const capability = peer.relayCapability || {};
  return {
    visible: capability.visible !== false,
    battery: BATTERY_RANK[capability.battery] === undefined ? "unknown" : capability.battery,
    network: NETWORK_RANK[capability.network] === undefined ? "unknown" : capability.network,
    capacity: Math.min(capability.selfCapacity ?? 50, capability.observedCapacity ?? 50),
    delivery: capability.deliveryRatio ?? 1,
  };
}

function relayRank(peer) {
  const capability = capabilityOf(peer);
  return [
    capability.visible ? 1 : 0,
    BATTERY_RANK[capability.battery],
    NETWORK_RANK[capability.network],
    capability.capacity,
    capability.delivery,
    peer.id,
  ];
}

function compareRanks(left, right) {
  for (let index = 0; index < left.length - 1; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return left.at(-1).localeCompare(right.at(-1));
}

function makeLeaseId(rootPeerId, parentPeerId, childPeerId, routeEpoch) {
  return crypto
    .createHash("sha256")
    .update(`${rootPeerId}\0${parentPeerId}\0${childPeerId}\0${routeEpoch}`)
    .digest("base64url")
    .slice(0, 22);
}

export function isEligibleRelay(peer, blockedRelayIds = new Set()) {
  const capability = capabilityOf(peer);
  return peer.relayConsent === true
    && capability.visible
    && capability.battery !== "critical"
    && capability.network !== "constrained"
    && capability.capacity >= 25
    && capability.delivery >= 0.8
    && !blockedRelayIds.has(peer.id);
}

export function buildRelayTree(peerIds, rootPeerId, eligibleRelayIds, options = {}) {
  const maxChildren = options.maxChildren ?? 3;
  const maxHops = options.maxHops ?? 3;
  const routeEpoch = options.routeEpoch ?? 1;
  const expiresAt = options.expiresAt ?? Date.now() + 60_000;
  const ranks = options.ranks ?? new Map();
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
    .sort((left, right) => (
      Number(eligible.has(right)) - Number(eligible.has(left))
      || compareRanks(ranks.get(left) || [0, 0, 0, 0, 0, left], ranks.get(right) || [0, 0, 0, 0, 0, right])
    ));
  const parents = [{ peerId: rootPeerId, depth: 0, children: 0 }];
  const edges = [];

  while (remaining.length > 0) {
    const parent = parents.find((candidate) => (
      candidate.depth < maxHops && candidate.children < maxChildren
    ));
    if (!parent) return null;
    const childPeerId = remaining.shift();
    const depth = parent.depth + 1;
    const backup = parents.find((candidate) => (
      candidate.peerId !== parent.peerId
      && candidate.depth < maxHops
      && candidate.children < maxChildren
      && candidate.peerId !== childPeerId
    ));
    edges.push(Object.freeze({
      leaseId: makeLeaseId(rootPeerId, parent.peerId, childPeerId, routeEpoch),
      parentPeerId: parent.peerId,
      backupParentPeerId: backup?.peerId || null,
      childPeerId,
      depth,
      expiresAt,
    }));
    parent.children += 1;
    if (eligible.has(childPeerId) && depth < maxHops) {
      parents.push({ peerId: childPeerId, depth, children: 0 });
    }
  }
  return Object.freeze(edges);
}

export function buildRoomTopology(peers, epochs, options = {}) {
  const enabled = options.enabled ?? true;
  const minimumParticipants = options.minimumParticipants ?? 6;
  const leaseMs = options.leaseMs ?? 60_000;
  const now = options.now ?? Date.now();
  const blockedRelayIds = options.blockedRelayIds ?? new Set();
  const normalizedEpochs = Number.isSafeInteger(epochs)
    ? { membership: epochs, route: epochs, topology: epochs }
    : epochs;
  const peerIds = normalizedPeerIds(peers);
  const ranks = new Map(peers.map((peer) => [peer.id, relayRank(peer)]));
  const eligible = peers
    .filter((peer) => isEligibleRelay(peer, blockedRelayIds))
    .sort((left, right) => compareRanks(ranks.get(left.id), ranks.get(right.id)))
    .map((peer) => peer.id);
  const expiresAt = now + leaseMs;
  const routes = peerIds.map((rootPeerId) => {
    const edges = enabled && peerIds.length >= minimumParticipants
      ? buildRelayTree(peerIds, rootPeerId, eligible, {
        ...options,
        routeEpoch: normalizedEpochs.route,
        expiresAt,
        ranks,
      })
      : null;
    return Object.freeze({
      rootPeerId,
      scopeId: `video:${rootPeerId}`,
      mode: edges ? "trusted_peer_relay" : "adaptive_mesh",
      edges: edges || [],
    });
  });
  return Object.freeze({
    type: "topology-state",
    membershipEpoch: normalizedEpochs.membership,
    routeEpoch: normalizedEpochs.route,
    topologyEpoch: normalizedEpochs.topology,
    leaseExpiresAt: expiresAt,
    peers: Object.freeze(peerIds),
    routes: Object.freeze(routes),
  });
}
