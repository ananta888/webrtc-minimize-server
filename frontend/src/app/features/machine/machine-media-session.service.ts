import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineMediaPublication } from "./machine-media-publication";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { createMachineMediaElement } from "./machine-media-element";

@Injectable()
export class MachineMediaSessionService implements OnDestroy {
  readonly publication: MachineMediaPublication;
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService, ownership: MachinePublicationOwnership) {
    this.publication = new MachineMediaPublication({ authority: () => {
      const lease = session.machineLease(), own = mesh.ownPeerId();
      if (!session.joined() || !lease || !mesh.machineReceive.isMachine(own)) throw new Error("machine_media_denied");
      return { sessionId: lease.sessionId, generation: lease.generation, expiresAt: lease.expiresAt,
        avatar: mesh.machineReceive.supports(own, "avatar.publish"), speech: mesh.machineReceive.supports(own, "speech.publish") };
    }, transportReady: () => mesh.mediaE2eeState() === "active" && mesh.overlayReady(),
      create: (bytes, outputs) => createMachineMediaElement(bytes, outputs, mesh, ownership) });
  }
  /** Additive v2 endpoint: explicit owned source and independent output rights; no implicit chat. */
  publish(input: unknown): Promise<void> {
    const keys = ["schema", "sourceId", "outputs", "mp4Base64"];
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("machine_media_request_invalid");
    const value = input as Record<string, unknown>, context = this.session.machineContext();
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value["schema"] !== "ananta.meet-media-source.v1" || !context
      || value["sourceId"] !== "media:" + context.hubSessionId) throw new Error("machine_media_source_denied");
    return this.publication.publish(value["mp4Base64"], value["outputs"]);
  }
  ngOnDestroy(): void { this.publication.close(); }
}
