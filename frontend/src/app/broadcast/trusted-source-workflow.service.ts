import { Injectable, OnDestroy, signal } from "@angular/core";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { DeviceIdentityService } from "../identity/device-identity.service";
import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { RoomSessionService } from "../webrtc/room-session.service";
import { SignalingService } from "../webrtc/signaling.service";
import { cumulativeIceServers } from "../webrtc/ice-policy";
import { SourcePublisherContext, sourceIdentityReferences } from "./trusted-source-actions";
import { TrustedSourcePublisher } from "./trusted-source-publisher";
import { SourceWorkflowView, TrustedSourceWorkflow } from "./trusted-source-workflow";

/** Root-owned active publishers survive panel navigation, never a room/session change. */
@Injectable({ providedIn: "root" })
export class TrustedSourceWorkflowService implements OnDestroy {
  readonly view = signal<SourceWorkflowView>({ preparing: false, selection: null, error: "", publications: [] });
  readonly workflow: TrustedSourceWorkflow;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly auth: OidcAuthService, private readonly device: DeviceIdentityService,
    private readonly room: RoomSessionService, private readonly mesh: PeerMeshService, private readonly signaling: SignalingService) {
    this.workflow = new TrustedSourceWorkflow({ context: () => this.context(),
      references: async context => {
        const [issuer, subject] = JSON.parse(context.identity) as [string, string];
        return sourceIdentityReferences(issuer, subject, context.fingerprint);
      },
      track: publication => mesh.ownPublicationTrack(publication.publicationId, publication.source),
      send: message => signaling.sendSourceControl(message), changed: view => this.view.set(view),
      start: (lease, track, signal, authorized, onState) => {
        const policy = room.icePolicy();
        if (!policy || !authorized(lease)) throw new Error("trusted_source_session_changed");
        return TrustedSourcePublisher.start(lease, track, { iceServers: [...cumulativeIceServers(policy, 2)] },
          { signal, authorized, onState, sendSignal: message => signaling.sendSourceControl(message) });
      },
    });
    this.unsubscribe = signaling.subscribe(message => this.workflow.receive(message));
    this.timer = setInterval(() => this.workflow.tick(), 250);
  }
  private context(): SourcePublisherContext | null {
    const claims = this.auth.claims(), fingerprint = this.device.fingerprint();
    const issuer = claims?.["iss"], subject = claims?.["sub"], expiry = claims?.["exp"];
    if (!this.room.joined() || this.room.machineExpiresAt() || this.signaling.status() !== "connected"
      || this.mesh.ownPeerId() !== this.room.peerId() || this.mesh.membershipEpoch() < 1
      || typeof issuer !== "string" || !issuer || issuer.length > 2048
      || typeof subject !== "string" || !subject || subject.length > 1024
      || typeof expiry !== "number" || !Number.isFinite(expiry) || expiry * 1000 <= Date.now() || !fingerprint) return null;
    return Object.freeze({ roomId: this.room.roomId(), peerId: this.room.peerId(), roomEpoch: this.mesh.membershipEpoch(),
      fingerprint, identity: JSON.stringify([issuer, subject]) });
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.unsubscribe(); this.workflow.destroy(); }
}
