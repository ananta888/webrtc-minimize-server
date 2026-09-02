import { ServerMessage } from "./signaling.service";
import { ValidatedTopologyState, validateTopologyState } from "./topology-contract";

interface MaterializedRoute {
  readonly mode: "adaptive_mesh" | "trusted_peer_relay";
  readonly children: ReadonlyMap<string, ReadonlySet<string>>;
  readonly paths: ReadonlyMap<string, readonly string[]>;
}

export interface PeerTopologyAnalysisEdge {
  readonly rootPeerId: string;
  readonly parentPeerId: string;
  readonly childPeerId: string;
}

export class PeerTopologyController {
  #routes = new Map<string, MaterializedRoute>();
  #membershipEpoch = 0;
  #routeEpoch = 0;
  #topologyEpoch = 0;
  #leaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onLeaseExpired: () => void) {}

  apply(
    message: ServerMessage,
    peerIds: readonly string[],
    limits: Readonly<{ maxChildren: number; maxHops: number }>,
  ): ValidatedTopologyState | null {
    const state = validateTopologyState(
      message,
      peerIds,
      this.#topologyEpoch,
      limits,
      this.#membershipEpoch,
      this.#routeEpoch,
    );
    if (!state) return null;
    const routes = new Map<string, MaterializedRoute>();
    for (const route of state.routes) {
      const children = new Map<string, Set<string>>();
      const parents = new Map<string, string>();
      for (const edge of route.edges) {
        const childSet = children.get(edge.parentPeerId) || new Set<string>();
        childSet.add(edge.childPeerId);
        children.set(edge.parentPeerId, childSet);
        parents.set(edge.childPeerId, edge.parentPeerId);
      }
      const paths = new Map<string, readonly string[]>();
      for (const destination of state.peers) {
        if (destination === route.rootPeerId) continue;
        const reverse = [destination];
        let current = destination;
        while (current !== route.rootPeerId && parents.has(current)) {
          current = parents.get(current)!;
          reverse.push(current);
        }
        if (current === route.rootPeerId) paths.set(destination, reverse.reverse());
      }
      routes.set(route.rootPeerId, {
        mode: route.mode,
        children: new Map([...children].map(([parent, values]) => [parent, new Set(values)])),
        paths,
      });
    }
    this.#routes = routes;
    this.#membershipEpoch = state.membershipEpoch;
    this.#routeEpoch = state.routeEpoch;
    this.#topologyEpoch = state.topologyEpoch;
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    this.#leaseTimer = setTimeout(() => {
      this.#routes.clear();
      this.onLeaseExpired();
    }, Math.max(0, state.leaseExpiresAt - Date.now()));
    return state;
  }

  mode(rootPeerId: string): "adaptive_mesh" | "trusted_peer_relay" {
    return this.#routes.get(rootPeerId)?.mode || "adaptive_mesh";
  }

  children(rootPeerId: string, parentPeerId: string): ReadonlySet<string> {
    return this.#routes.get(rootPeerId)?.children.get(parentPeerId) || new Set<string>();
  }

  path(rootPeerId: string, destinationPeerId: string): readonly string[] | null {
    return this.#routes.get(rootPeerId)?.paths.get(destinationPeerId) || null;
  }

  analysisEdges(): readonly PeerTopologyAnalysisEdge[] {
    const edges: PeerTopologyAnalysisEdge[] = [];
    for (const [rootPeerId, route] of this.#routes) {
      if (route.mode !== "trusted_peer_relay") continue;
      for (const [parentPeerId, children] of route.children) {
        for (const childPeerId of children) edges.push(Object.freeze({
          rootPeerId,
          parentPeerId,
          childPeerId,
        }));
      }
    }
    return Object.freeze(edges.sort((left, right) => (
      `${left.rootPeerId}:${left.parentPeerId}:${left.childPeerId}`
        .localeCompare(`${right.rootPeerId}:${right.parentPeerId}:${right.childPeerId}`)
    )));
  }

  clear(): void {
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    this.#leaseTimer = null;
    this.#routes.clear();
    this.#membershipEpoch = 0;
    this.#routeEpoch = 0;
    this.#topologyEpoch = 0;
  }
}
