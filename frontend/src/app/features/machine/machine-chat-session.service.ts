import { Injectable, OnDestroy } from "@angular/core";
import { MachineChatAuthority } from "../../../../../src/machine-chat-queue.js";
import { validateMachineChatScope } from "../../../../../src/machine-chat-contract.js";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineChatEndpoint } from "./machine-chat-endpoint";

@Injectable()
export class MachineChatSessionService implements OnDestroy {
  readonly endpoint: MachineChatEndpoint;
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService) {
    this.endpoint = new MachineChatEndpoint({ authority: () => this.authority(),
      subscribe: listener => mesh.subscribeMachineChat(listener),
      sourceAllowed: peerId => mesh.peerChoices().some(peer => peer.id === peerId)
        && mesh.machineReceive.chatAllowed(mesh.ownPeerId(), peerId),
      sendReply: (text, replyTo) => mesh.sendMachineChatReply(text, replyTo) });
  }
  private authority(): MachineChatAuthority {
    const context = this.session.machineContext(), lease = this.session.machineLease(), own = this.mesh.ownPeerId();
    const grants = this.mesh.machineReceive.grants().filter(g => g.machinePeerId === own && g.chatRead && g.expiresAt > Date.now());
    if (!context || !lease || !this.session.joined() || !this.mesh.machineReceive.isMachine(own)
      || !grants.length || !this.mesh.machineReceive.supports(own, "chat.read")
      || !this.mesh.machineReceive.supports(own, "chat.send")) throw new Error("meet_chat_receive_denied");
    const scope = validateMachineChatScope({ origin: location.origin, tenant_id: context.tenantId,
      project_id: context.projectId, task_id: context.taskId, runtime_id: context.runtimeId,
      session_id: context.hubSessionId, lease_id: lease.sessionId, generation: lease.generation,
      room_id: this.session.roomId(), own_peer_id: own, membership_epoch: this.mesh.membershipEpoch(),
      policy_revision: this.mesh.machineReceive.revision(), deadline_ms: Math.min(lease.expiresAt, ...grants.map(g => g.expiresAt)) });
    return Object.freeze({ chatRead: true, chatSend: true, scope });
  }
  ngOnDestroy(): void { this.endpoint.close(); }
}
