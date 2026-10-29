import { Injectable, computed } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";

/** Membership-bound observation only; never issues a receive grant or starts capture. */
@Injectable()
export class MachineReceiveObservationService {
  readonly activities = computed(() => {
    if (!this.session.joined()) return [];
    return this.mesh.peerChoices().filter(peer => this.mesh.machineReceive.isMachine(peer.id)).map(peer => {
      const available = (source: string) => this.mesh.remoteMedia().some(media => media.peerId === peer.id
        && media.source === source && media.stream.getTracks().some(track => track.readyState === "live" && !track.muted));
      const supports = (capability: string) => this.mesh.machineReceive.supports(peer.id, capability);
      return Object.freeze({ ...peer, audioSupported: supports("audio.receive"), videoSupported: supports("video.receive"),
        chatReadSupported: supports("chat.read"), chatSendSupported: supports("chat.send"),
        screenAvailable: available("screen"), screenAudioAvailable: available("screen-audio"),
        avatarAvailable: available("camera"), speechAvailable: available("microphone") });
    });
  });
  constructor(private readonly mesh: PeerMeshService, private readonly session: RoomSessionService) {}
}
