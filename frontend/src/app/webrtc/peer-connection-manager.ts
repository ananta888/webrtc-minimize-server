import { LinkClass } from "./media-optimization-policy";
import { ServerMessage } from "./signaling.service";

export type PeerChannelKind = "chat" | "control" | "overlay";

export interface ManagedPeer {
  readonly id: string;
  readonly name: string;
  readonly pc: RTCPeerConnection;
  readonly channels: Map<PeerChannelKind, RTCDataChannel>;
  readonly senders: Map<string, RTCRtpSender>;
  readonly appliedTiers: Map<string, string>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  readonly polite: boolean;
  linkClass: LinkClass;
  reportedLinkClass: LinkClass;
  lastControlSequence: number;
  healthSamples: number;
  linkCandidate: LinkClass;
  linkCandidateSince: number;
}

interface ManagerCallbacks {
  readonly signal: (to: string, payload: object) => void;
  readonly track: (peer: ManagedPeer, track: MediaStreamTrack) => void;
  readonly channel: (peer: ManagedPeer, channel: RTCDataChannel) => void;
  readonly state: () => void;
  readonly negotiationError: (peer: ManagedPeer) => void;
}

export class PeerConnectionManager {
  readonly peers = new Map<string, ManagedPeer>();

  constructor(
    private readonly ownPeerId: string,
    private readonly iceServers: readonly RTCIceServer[],
    private readonly dataOverlayEnabled: boolean,
    private readonly callbacks: ManagerCallbacks,
  ) {}

  add(peerId: string, name: string): ManagedPeer | null {
    if (!peerId || peerId === this.ownPeerId) return null;
    const current = this.peers.get(peerId);
    if (current) return current;
    const pc = new RTCPeerConnection({ iceServers: [...this.iceServers] });
    const peer: ManagedPeer = {
      id: peerId,
      name: name || "Peer",
      pc,
      channels: new Map(),
      senders: new Map(),
      appliedTiers: new Map(),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      polite: this.ownPeerId > peerId,
      linkClass: "unknown",
      reportedLinkClass: "unknown",
      lastControlSequence: -1,
      healthSamples: 0,
      linkCandidate: "unknown",
      linkCandidateSince: Date.now(),
    };
    this.peers.set(peerId, peer);
    pc.onicecandidate = ({ candidate }) => this.callbacks.signal(peerId, { candidate });
    pc.ontrack = ({ track }) => this.callbacks.track(peer, track);
    pc.ondatachannel = ({ channel }) => this.callbacks.channel(peer, channel);
    pc.oniceconnectionstatechange = this.callbacks.state;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
      this.callbacks.state();
    };
    pc.onnegotiationneeded = () => void this.negotiate(peer);
    if (this.ownPeerId < peerId) {
      this.callbacks.channel(peer, pc.createDataChannel("control", { ordered: true }));
      this.callbacks.channel(peer, pc.createDataChannel("chat", { ordered: true }));
      if (this.dataOverlayEnabled) {
        this.callbacks.channel(peer, pc.createDataChannel("overlay", { ordered: false, maxRetransmits: 3 }));
      }
    }
    return peer;
  }

  async acceptSignal(message: ServerMessage): Promise<void> {
    const from = String(message["from"] || "");
    const peer = this.add(from, String(message["fromName"] || "Peer"));
    if (!peer) return;
    try {
      const description = message["description"] as RTCSessionDescriptionInit | undefined;
      if (description) {
        const readyForOffer = !peer.makingOffer
          && (peer.pc.signalingState === "stable" || peer.settingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        peer.settingRemoteAnswerPending = description.type === "answer";
        await peer.pc.setRemoteDescription(description);
        peer.settingRemoteAnswerPending = false;
        if (description.type === "offer") {
          await peer.pc.setLocalDescription();
          this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
        }
        return;
      }
      try {
        await peer.pc.addIceCandidate((message["candidate"] as RTCIceCandidateInit | null) ?? null);
      } catch (error) {
        if (!peer.ignoreOffer) throw error;
      }
    } catch {
      peer.settingRemoteAnswerPending = false;
      this.callbacks.negotiationError(peer);
    }
  }

  remove(peerId: string): ManagedPeer | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    for (const channel of peer.channels.values()) channel.close();
    peer.pc.close();
    this.peers.delete(peerId);
    return peer;
  }

  close(): void {
    for (const peerId of [...this.peers.keys()]) this.remove(peerId);
  }

  private async negotiate(peer: ManagedPeer): Promise<void> {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
    } catch {
      this.callbacks.negotiationError(peer);
    } finally {
      peer.makingOffer = false;
    }
  }
}
