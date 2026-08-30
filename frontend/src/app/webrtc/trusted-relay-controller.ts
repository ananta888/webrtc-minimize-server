import { PeerTopologyController } from "./peer-topology-controller";

export class TrustedRelayController {
  constructor(private readonly topology: PeerTopologyController) {}

  shouldSend(input: Readonly<{
    trackKind: string;
    publicationLocal: boolean;
    rootPeerId: string;
    ownPeerId: string;
    targetPeerId: string;
  }>): boolean {
    if (input.trackKind === "audio") return input.publicationLocal;
    if (this.topology.mode(input.rootPeerId) === "adaptive_mesh") return input.publicationLocal;
    return this.topology.children(input.rootPeerId, input.ownPeerId).has(input.targetPeerId);
  }
}
