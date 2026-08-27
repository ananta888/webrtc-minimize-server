export interface TopologyEdge {
  readonly parentPeerId: string;
  readonly childPeerId: string;
  readonly depth: number;
}

export interface ValidatedTopologyRoute {
  readonly rootPeerId: string;
  readonly mode: "adaptive_mesh" | "trusted_peer_relay";
  readonly edges: readonly TopologyEdge[];
}

export interface ValidatedTopologyState {
  readonly epoch: number;
  readonly routes: readonly ValidatedTopologyRoute[];
}

export function validateTopologyState(
  raw: Readonly<Record<string, unknown>>,
  peerIds: readonly string[],
  lastEpoch: number,
  limits: Readonly<{ maxChildren: number; maxHops: number }>,
): ValidatedTopologyState | null {
  if (Object.keys(raw).some((key) => !new Set(["version", "type", "epoch", "routes"]).has(key))) return null;
  if (raw["version"] !== 1 || raw["type"] !== "topology-state") return null;
  const epoch = Number(raw["epoch"]);
  if (!Number.isSafeInteger(epoch) || epoch <= lastEpoch) return null;
  const members = new Set(peerIds);
  const rawRoutes = raw["routes"];
  if (!Array.isArray(rawRoutes) || rawRoutes.length !== members.size) return null;
  const roots = new Set<string>();
  const routes: ValidatedTopologyRoute[] = [];
  for (const rawRoute of rawRoutes) {
    if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) return null;
    const value = rawRoute as Record<string, unknown>;
    if (Object.keys(value).some((key) => !new Set(["rootPeerId", "mode", "edges"]).has(key))) return null;
    const rootPeerId = String(value["rootPeerId"] || "");
    const mode = String(value["mode"] || "");
    if (!members.has(rootPeerId) || roots.has(rootPeerId)
      || !new Set(["adaptive_mesh", "trusted_peer_relay"]).has(mode)) return null;
    roots.add(rootPeerId);
    if (!Array.isArray(value["edges"]) || value["edges"].length > Math.max(0, members.size - 1)) return null;
    const childParents = new Map<string, string>();
    const childCounts = new Map<string, number>();
    const edges: TopologyEdge[] = [];
    for (const rawEdge of value["edges"]) {
      if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) return null;
      const edge = rawEdge as Record<string, unknown>;
      if (Object.keys(edge).some((key) => !new Set(["parentPeerId", "childPeerId", "depth"]).has(key))) return null;
      const parentPeerId = String(edge["parentPeerId"] || "");
      const childPeerId = String(edge["childPeerId"] || "");
      const depth = Number(edge["depth"]);
      if (!members.has(parentPeerId) || !members.has(childPeerId) || parentPeerId === childPeerId
        || !Number.isSafeInteger(depth) || depth < 1 || depth > limits.maxHops
        || childParents.has(childPeerId)) return null;
      childParents.set(childPeerId, parentPeerId);
      childCounts.set(parentPeerId, (childCounts.get(parentPeerId) || 0) + 1);
      if ((childCounts.get(parentPeerId) || 0) > limits.maxChildren) return null;
      edges.push({ parentPeerId, childPeerId, depth });
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
    routes.push({ rootPeerId, mode: mode as ValidatedTopologyRoute["mode"], edges });
  }
  if (roots.size !== members.size) return null;
  return { epoch, routes };
}
