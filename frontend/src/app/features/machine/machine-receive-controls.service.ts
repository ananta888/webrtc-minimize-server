import { Injectable, OnDestroy, computed, signal } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { SignalingService } from "../../webrtc/signaling.service";

@Injectable()
export class MachineReceiveControlsService implements OnDestroy {
  readonly targets = computed(() => this.mesh.peerChoices().filter(peer => this.mesh.machineReceive.isMachine(peer.id)));
  readonly state = signal<"idle" | "pending" | "confirmed" | "failed">("idle");
  readonly error = signal("");
  private readonly now = signal(Date.now());
  private readonly refresh = setInterval(() => this.now.set(Date.now()), 1000);
  readonly activities = computed(() => {
    const now = this.now();
    return this.targets().map(peer => {
      const grant = this.mesh.ownMachineReceiveGrant(peer.id);
      const available = (source: string) => this.mesh.remoteMedia().some(media => media.peerId === peer.id
        && media.source === source && media.stream.getTracks().some(track => track.readyState === "live" && !track.muted));
      return Object.freeze({ ...peer, grant: grant && grant.expiresAt > now ? grant : null,
        grantState: grant ? grant.expiresAt > now ? "granted" : "expired" : "none",
        audioSupported: this.mesh.machineReceive.supports(peer.id, "audio.receive"),
        chatReadSupported: this.mesh.machineReceive.supports(peer.id, "chat.read"),
        chatSendSupported: this.mesh.machineReceive.supports(peer.id, "chat.send"),
        screenSupported: this.mesh.machineReceive.supports(peer.id, "screen.publish"),
        screenAvailable: available("screen"), screenAudioAvailable: available("screen-audio"),
        avatarAvailable: available("camera"), speechAvailable: available("microphone") });
    });
  });
  private pending: ReturnType<PeerMeshService["machineReceiveConsent"]> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: () => void;
  constructor(readonly mesh: PeerMeshService, private readonly session: RoomSessionService, private readonly signaling: SignalingService) {
    this.unsubscribe = signaling.subscribe(message => {
      const pending = this.pending;
      if (!pending) return;
      if (message.type === "error" && typeof message["code"] === "string" && /^machine_receive_[a-z_]{1,64}$/.test(message["code"])) {
        this.finish(false, message["code"]); return;
      }
      if (message.type !== "machine-receive-state" || message["roomId"] !== this.session.roomId()
        || this.mesh.machineReceive.revision() <= pending.expectedRevision) return;
      const current = mesh.ownMachineReceiveGrant(pending.machinePeerId);
      const matched = pending.publicationIds.length || pending.chatRead
        ? current?.expiresAt === pending.expiresAt && current.chatRead === pending.chatRead
          && JSON.stringify([...current.publicationIds].sort()) === JSON.stringify([...pending.publicationIds].sort())
        : current === null;
      if (matched) this.finish(true);
    });
  }
  request(peerId: string, microphone: boolean, screenAudio: boolean, chatRead: boolean, minutes: number, trigger: unknown): void {
    if (trigger !== "user-action" || !this.session.joined() || this.session.machineExpiresAt() || this.pending) return;
    this.error.set("");
    try {
      const command = this.mesh.machineReceiveConsent(peerId, microphone, screenAudio, chatRead, minutes);
      this.pending = command; this.state.set("pending");
      this.timeout = setTimeout(() => this.finish(false, "machine_receive_ack_timeout"), 5000);
      this.signaling.send(command);
    } catch (error) {
      const code = error instanceof Error && /^machine_receive_[a-z_]{1,64}$/.test(error.message)
        ? error.message : "machine_receive_request_failed";
      this.finish(false, code);
    }
  }
  private finish(success: boolean, code = ""): void {
    if (this.timeout) clearTimeout(this.timeout); this.timeout = null; this.pending = null;
    this.state.set(success ? "confirmed" : "failed"); this.error.set(code);
  }
  ngOnDestroy(): void {
    this.unsubscribe(); clearInterval(this.refresh); if (this.timeout) clearTimeout(this.timeout); this.pending = null;
  }
}
