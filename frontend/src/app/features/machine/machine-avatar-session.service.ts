import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineAvatarSource } from "./machine-avatar-source";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";

@Injectable()
export class MachineAvatarSessionService implements OnDestroy {
  readonly source: MachineAvatarSource;
  constructor(session: RoomSessionService, mesh: PeerMeshService, surfaces: MachineAvatarSurfaceFactory) {
    this.source = new MachineAvatarSource({ authority: () => {
      const context = session.machineContext(), lease = session.machineLease();
      if (!session.joined() || !context || !lease || !mesh.machineReceive.supports(mesh.ownPeerId(), "avatar.publish")) {
        throw new Error("meet_avatar_source_denied");
      }
      return { sourceId: "avatar:" + context.hubSessionId, sessionId: lease.sessionId, leaseGeneration: lease.generation,
        membershipEpoch: mesh.membershipEpoch(), expiresAt: lease.expiresAt };
    }, create: () => surfaces.create() });
  }
  ngOnDestroy(): void { this.source.close(); }
}
