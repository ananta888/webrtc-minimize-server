import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineSpeechGraphFactory } from "./machine-speech-graph";
import { MachineSpeechAuthority, MachineSpeechSource } from "./machine-speech-source";

@Injectable()
export class MachineSpeechSessionService implements OnDestroy {
  readonly source: MachineSpeechSource;
  constructor(session: RoomSessionService, mesh: PeerMeshService, graph: MachineSpeechGraphFactory) {
    const authority = (): MachineSpeechAuthority => {
      const context = session.machineContext(), lease = session.machineLease();
      if (!session.joined() || !context || !lease || !mesh.machineReceive.supports(mesh.ownPeerId(), "speech.publish")) {
        throw new Error("meet_speech_source_denied");
      }
      return { sourceId: "speech:" + context.hubSessionId, sessionId: lease.sessionId, leaseGeneration: lease.generation,
        membershipEpoch: mesh.membershipEpoch(), expiresAt: lease.expiresAt };
    };
    this.source = new MachineSpeechSource({ authority, create: (samples, progress, failed, signal) =>
      graph.create(samples, authority().expiresAt, progress, failed, signal) });
  }
  ngOnDestroy(): void { this.source.close(); }
}
