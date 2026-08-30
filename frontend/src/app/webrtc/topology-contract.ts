export interface TopologyEdge {
  readonly leaseId: string;
  readonly parentPeerId: string;
  readonly backupParentPeerId: string | null;
  readonly childPeerId: string;
  readonly depth: number;
  readonly expiresAt: number;
}

export interface ValidatedTopologyRoute {
  readonly rootPeerId: string;
  readonly scopeId: string;
  readonly mode: "adaptive_mesh" | "trusted_peer_relay";
  readonly edges: readonly TopologyEdge[];
}

export interface ValidatedTopologyState {
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly topologyEpoch: number;
  readonly leaseExpiresAt: number;
  readonly peers: readonly string[];
  readonly routes: readonly ValidatedTopologyRoute[];
}

export function validateTopologyState(
  raw: Readonly<Record<string, unknown>>,
  peerIds: readonly string[],
  lastEpoch: number,
  limits: Readonly<{ maxChildren: number; maxHops: number }>,
  lastMembershipEpoch = 0,
  lastRouteEpoch = 0,
): ValidatedTopologyState | null {
  if (Object.keys(raw).some((key) => !new Set([
    "version", "type", "membershipEpoch", "routeEpoch", "topologyEpoch", "leaseExpiresAt", "peers", "routes",
  ]).has(key))) return null;
  if (raw["version"] !== 1 || raw["type"] !== "topology-state") return null;
  const membershipEpoch = Number(raw["membershipEpoch"]);
  const routeEpoch = Number(raw["routeEpoch"]);
  const topologyEpoch = Number(raw["topologyEpoch"]);
  const leaseExpiresAt = Number(raw["leaseExpiresAt"]);
  if (![membershipEpoch, routeEpoch, topologyEpoch].every((epoch) => Number.isSafeInteger(epoch) && epoch >= 1)
    || membershipEpoch < lastMembershipEpoch || routeEpoch <= lastRouteEpoch
    || topologyEpoch <= lastEpoch || !Number.isSafeInteger(leaseExpiresAt)
    || leaseExpiresAt <= Date.now() || leaseExpiresAt > Date.now() + 5 * 60_000) return null;
  const members = new Set(peerIds);
  if (!Array.isArray(raw["peers"]) || raw["peers"].length !== members.size
    || raw["peers"].some((peerId) => typeof peerId !== "string" || !members.has(peerId))) return null;
  const rawRoutes = raw["routes"];
  if (!Array.isArray(rawRoutes) || rawRoutes.length !== members.size) return null;
  const roots = new Set<string>();
  const routes: ValidatedTopologyRoute[] = [];
  for (const rawRoute of rawRoutes) {
    if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) return null;
    const value = rawRoute as Record<string, unknown>;
    if (Object.keys(value).some((key) => !new Set(["rootPeerId", "scopeId", "mode", "edges"]).has(key))) return null;
    const rootPeerId = String(value["rootPeerId"] || "");
    const scopeId = String(value["scopeId"] || "");
    const mode = String(value["mode"] || "");
    if (!members.has(rootPeerId) || roots.has(rootPeerId) || scopeId !== `video:${rootPeerId}`
      || !new Set(["adaptive_mesh", "trusted_peer_relay"]).has(mode)) return null;
    roots.add(rootPeerId);
    if (!Array.isArray(value["edges"]) || value["edges"].length > Math.max(0, members.size - 1)) return null;
    const childParents = new Map<string, string>();
    const childCounts = new Map<string, number>();
    const edges: TopologyEdge[] = [];
    for (const rawEdge of value["edges"]) {
      if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) return null;
      const edge = rawEdge as Record<string, unknown>;
      if (Object.keys(edge).some((key) => !new Set([
        "leaseId", "parentPeerId", "backupParentPeerId", "childPeerId", "depth", "expiresAt",
      ]).has(key))) return null;
      const leaseId = String(edge["leaseId"] || "");
      const parentPeerId = String(edge["parentPeerId"] || "");
      const backupParentPeerId = edge["backupParentPeerId"] === null
        ? null : String(edge["backupParentPeerId"] || "");
      const childPeerId = String(edge["childPeerId"] || "");
      const depth = Number(edge["depth"]);
      const expiresAt = Number(edge["expiresAt"]);
      if (!members.has(parentPeerId) || !members.has(childPeerId) || parentPeerId === childPeerId
        || !Number.isSafeInteger(depth) || depth < 1 || depth > limits.maxHops
        || childParents.has(childPeerId) || !/^[A-Za-z0-9_-]{22}$/.test(leaseId)
        || !Number.isSafeInteger(expiresAt) || expiresAt !== leaseExpiresAt
        || (backupParentPeerId !== null && (!members.has(backupParentPeerId)
          || backupParentPeerId === parentPeerId || backupParentPeerId === childPeerId))) return null;
      childParents.set(childPeerId, parentPeerId);
      childCounts.set(parentPeerId, (childCounts.get(parentPeerId) || 0) + 1);
      if ((childCounts.get(parentPeerId) || 0) > limits.maxChildren) return null;
      edges.push({ leaseId, parentPeerId, backupParentPeerId, childPeerId, depth, expiresAt });
    }
    if (mode === "adaptive_mesh" && edges.length > 0) return null;
    if (mode === "trusted_peer_relay") {
      if (childParents.size !== members.size - 1 || childParents.has(rootPeerId)) return null;
      for (const member of members) {
        if (member === rootPeerId) continue;
        const visited = new Set([member]);
        let current = member;
        while (current !== rootPeerId) {
          current = childParents.get(current) || "";
          if (!current || visited.has(current)) return null;
          visited.add(current);
        }
      }
    }
    routes.push({ rootPeerId, scopeId, mode: mode as ValidatedTopologyRoute["mode"], edges });
  }
  if (roots.size !== members.size) return null;
  return {
    membershipEpoch,
    routeEpoch,
    topologyEpoch,
    leaseExpiresAt,
    peers: [...members].sort(),
    routes,
  };
}
