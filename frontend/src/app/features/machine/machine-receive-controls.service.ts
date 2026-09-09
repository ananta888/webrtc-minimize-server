import { Injectable, OnDestroy, computed, signal } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { SignalingService } from "../../webrtc/signaling.service";
import { selectedReceiveSources, VisualReceiveSelection } from "../../webrtc/machine-receive-selection";

/** A local editor snapshot, never a grant or a substitute for server policy. */
export interface MachineReceiveSelection {
  readonly roomId: string;
  readonly peerId: string;
  readonly machinePeerId: string;
  readonly sources: readonly Readonly<{ publicationId: string; source: string }>[];
}

@Injectable()
export class MachineReceiveControlsService implements OnDestroy {
  readonly targets = computed(() => this.mesh.peerChoices().filter(peer => this.mesh.machineReceive.isMachine(peer.id)));
  readonly state = signal<"idle" | "pending" | "confirmed" | "expired" | "failed">("idle");
  readonly error = signal("");
  readonly requestPeerId = signal("");
  private readonly now = signal(Date.now());
  private readonly refresh = setInterval(() => { this.now.set(Date.now()); this.reconcile(); }, 250);
  readonly sources = computed(() => {
    this.now();
    return this.session.joined() && !this.session.machineExpiresAt() ? this.mesh.ownMachineReceiveSources() : [];
  });
  readonly activities = computed(() => {
    const now = this.now();
    return this.targets().map(peer => {
      const grant = this.mesh.ownMachineReceiveGrant(peer.id);
      const activeGrant = grant && grant.expiresAt > now ? grant : null;
      const available = (source: string) => this.mesh.remoteMedia().some(media => media.peerId === peer.id
        && media.source === source && media.stream.getTracks().some(track => track.readyState === "live" && !track.muted));
      return Object.freeze({ ...peer, grant: activeGrant,
        grantState: grant ? grant.expiresAt > now ? "granted" : "expired" : "none",
        audioSupported: this.mesh.machineReceive.supports(peer.id, "audio.receive"),
        videoSupported: this.mesh.machineReceive.supports(peer.id, "video.receive"),
        audioGrantCount: this.sources().filter(source => ["microphone", "screen-audio"].includes(source.source)
          && activeGrant?.publicationIds.includes(source.publicationId)).length,
        videoGrantCount: this.sources().filter(source => ["camera", "screen"].includes(source.source)
          && activeGrant?.publicationIds.includes(source.publicationId)).length,
        chatReadSupported: this.mesh.machineReceive.supports(peer.id, "chat.read"),
        chatSendSupported: this.mesh.machineReceive.supports(peer.id, "chat.send"),
        screenSupported: this.mesh.machineReceive.supports(peer.id, "screen.publish"),
        screenAvailable: available("screen"), screenAudioAvailable: available("screen-audio"),
        avatarAvailable: available("camera"), speechAvailable: available("microphone") });
    });
  });
  private pending: ReturnType<PeerMeshService["machineReceiveConsent"]> | null = null;
  private receipt: ReturnType<PeerMeshService["machineReceiveConsent"]> | null = null;
  private scope: Readonly<{ roomId: string; peerId: string }> | null = null;
  private destroyed = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: () => void;
  constructor(readonly mesh: PeerMeshService, private readonly session: RoomSessionService, private readonly signaling: SignalingService) {
    this.unsubscribe = signaling.subscribe(message => {
      this.reconcile();
      const pending = this.pending;
      if (!pending) return;
      if (message.type === "error" && typeof message["code"] === "string" && /^machine_receive_[a-z_]{1,64}$/.test(message["code"])) {
        this.finish(false, message["code"]); return;
      }
      if (message.type !== "machine-receive-state" || message["roomId"] !== this.session.roomId()
        || this.mesh.machineReceive.revision() <= pending.expectedRevision) return;
      if (this.matches(pending)) this.finish(true);
    });
  }
  selection(peerId: string) {
    const grant = this.mesh.ownMachineReceiveGrant(peerId);
    const valid = grant && grant.expiresAt > Date.now();
    const allows = (source: string) => Boolean(valid && this.sources().some(value => value.source === source
      && grant.publicationIds.includes(value.publicationId)));
    return { microphone: allows("microphone"), screenAudio: allows("screen-audio"), chat: Boolean(valid && grant.chatRead),
      ...(this.mesh.machineReceive.supports(peerId, "video.receive") ? { camera: allows("camera"), screen: allows("screen") } : {}) };
  }
  sourceAvailable(source: string): boolean { return this.sources().some(value => value.source === source); }
  selectionScope(machinePeerId: string): MachineReceiveSelection {
    return Object.freeze({ roomId: this.session.roomId(), peerId: this.session.peerId(), machinePeerId,
      sources: Object.freeze(this.mesh.ownMachineReceiveSources().map(source => Object.freeze({ ...source }))) });
  }
  private selectedPublications(selected: MachineReceiveSelection | undefined, machinePeerId: string,
    microphone: boolean, screenAudio: boolean, visual?: VisualReceiveSelection): readonly string[] {
    if (!selected || selected.roomId !== this.session.roomId() || selected.peerId !== this.session.peerId()
      || selected.machinePeerId !== machinePeerId) throw new Error("machine_receive_selection_changed");
    const kinds = selectedReceiveSources(microphone, screenAudio, visual);
    const sources = selected.sources.filter(source => kinds.includes(source.source));
    if (sources.length !== kinds.length || new Set(sources.map(source => source.source)).size !== kinds.length)
      throw new Error("machine_receive_selection_changed");
    return sources.map(source => source.publicationId).sort();
  }
  private matches(command: NonNullable<typeof this.pending>): boolean {
    const current = this.mesh.ownMachineReceiveGrant(command.machinePeerId);
    return command.publicationIds.length || command.chatRead
      ? current?.expiresAt === command.expiresAt && current.chatRead === command.chatRead
        && JSON.stringify([...current.publicationIds].sort()) === JSON.stringify([...command.publicationIds].sort())
      : current === null;
  }
  private reconcile(): void {
    if (this.destroyed || !this.scope) return;
    if (!this.session.joined() || this.session.machineExpiresAt() || this.scope.roomId !== this.session.roomId()
      || this.scope.peerId !== this.session.peerId() || !this.targets().some(peer => peer.id === this.requestPeerId())) {
      this.finish(false, "machine_receive_session_changed"); this.receipt = null; this.scope = null; return;
    }
    // Timer delivery and server replies can be delayed independently. Expiry is
    // checked before interpreting an ACK; revocation has no grant to extend.
    if (this.pending && (this.pending.chatRead || this.pending.publicationIds.length)
      && this.pending.expiresAt <= Date.now()) {
      this.finish(false); this.state.set("expired"); return;
    }
    if (this.receipt) {
      if ((this.receipt.chatRead || this.receipt.publicationIds.length) && this.receipt.expiresAt <= Date.now()) {
        this.receipt = null; this.state.set("expired");
      } else if (!this.matches(this.receipt)) {
        this.receipt = null; this.state.set("idle");
      }
    }
  }
  request(peerId: string, microphone: boolean, screenAudio: boolean, chatRead: boolean, minutes: number, trigger: unknown,
    selected?: MachineReceiveSelection, visual?: VisualReceiveSelection): void {
    this.reconcile();
    if (this.destroyed || trigger !== "user-action" || !this.session.joined() || this.session.machineExpiresAt() || this.pending) return;
    this.error.set("");
    this.receipt = null; this.requestPeerId.set(peerId);
    this.scope = Object.freeze({ roomId: this.session.roomId(), peerId: this.session.peerId() });
    try {
      // Grant clicks refer to the sources the user reviewed. Revocation needs no
      // snapshot and must remain possible after a source has stopped or changed.
      const expected = selectedReceiveSources(microphone, screenAudio, visual).length || chatRead
        ? this.selectedPublications(selected, peerId, microphone, screenAudio, visual) : [];
      const command = this.mesh.machineReceiveConsent(peerId, microphone, screenAudio, chatRead, minutes, visual);
      if (JSON.stringify([...command.publicationIds].sort()) !== JSON.stringify(expected))
        throw new Error("machine_receive_selection_changed");
      this.pending = command; this.state.set("pending");
      this.timeout = setTimeout(() => {
        this.reconcile();
        if (this.pending) this.finish(false, "machine_receive_ack_timeout");
      }, 5000);
      this.signaling.send(command);
    } catch (error) {
      const code = error instanceof Error && /^machine_receive_[a-z_]{1,64}$/.test(error.message)
        ? error.message : "machine_receive_request_failed";
      this.finish(false, code);
    }
  }
  private finish(success: boolean, code = ""): void {
    this.receipt = success ? this.pending : null;
    if (this.timeout) clearTimeout(this.timeout); this.timeout = null; this.pending = null;
    this.state.set(success ? "confirmed" : "failed"); this.error.set(code);
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.receipt = null; this.scope = null;
    this.unsubscribe(); clearInterval(this.refresh); if (this.timeout) clearTimeout(this.timeout); this.pending = null;
  }
}
