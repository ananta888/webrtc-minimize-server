import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineAvatarSource } from "./machine-avatar-source";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";
import { MachineAvatarImageLoader } from "./machine-avatar-image";

@Injectable()
export class MachineAvatarSessionService implements OnDestroy {
  readonly source: MachineAvatarSource;
  constructor(session: RoomSessionService, mesh: PeerMeshService, surfaces: MachineAvatarSurfaceFactory) {
    const images = new MachineAvatarImageLoader({ create: artwork => surfaces.create(artwork) });
    this.source = new MachineAvatarSource({ authority: () => {
      const context = session.machineContext(), lease = session.machineLease();
      if (!session.joined() || !context || !lease || !mesh.machineReceive.supports(mesh.ownPeerId(), "avatar.publish")) {
        throw new Error("meet_avatar_source_denied");
      }
      return { sourceId: "avatar:" + context.hubSessionId, sessionId: lease.sessionId, leaseGeneration: lease.generation,
        membershipEpoch: mesh.membershipEpoch(), expiresAt: lease.expiresAt };
    }, create: (profile, image, check) => profile === "neutral-ai-v1" ? surfaces.create() : images.create(image, check) });
  }
  ngOnDestroy(): void { this.source.close(); }
}
