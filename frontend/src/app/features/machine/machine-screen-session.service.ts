import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineScreenSource } from "./machine-screen-source";
import { createMachineScreenSurface } from "./machine-screen-surface";
import { MachineMediaTimingService } from "./machine-media-timing.service";

@Injectable()
export class MachineScreenSessionService implements OnDestroy {
  readonly source: MachineScreenSource;
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService, timing: MachineMediaTimingService) {
    this.source = new MachineScreenSource({ authority: () => {
      const context = session.machineContext(), lease = session.machineLease();
      if (!session.joined() || !context || !lease || !mesh.machineReceive.supports(mesh.ownPeerId(), "screen.publish")) {
        throw new Error("meet_screen_source_denied");
      }
      return { sourceId: "screen:" + context.hubSessionId, sessionId: lease.sessionId, leaseGeneration: lease.generation,
        membershipEpoch: mesh.membershipEpoch(), expiresAt: lease.expiresAt };
    }, create: () => createMachineScreenSurface(mesh, timing),
      decode: bytes => createImageBitmap(new Blob([bytes], { type: "image/jpeg" })) });
  }
  ngOnDestroy(): void { this.source.close(); }
}
