import { LinkClass } from "./media-optimization-policy";
import {
  cumulativeIceServers,
  IcePathClass,
  IceTierPolicy,
  iceServerUrls,
} from "./ice-policy";
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
  iceTier: 0 | 1 | 2;
  icePath: IcePathClass;
  iceStartedAt: number;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  lastIceRestartAt: number;
}

interface ManagerCallbacks {
  readonly signal: (to: string, payload: object) => void;
  readonly track: (peer: ManagedPeer, track: MediaStreamTrack, receiver: RTCRtpReceiver) => void;
  readonly channel: (peer: ManagedPeer, channel: RTCDataChannel) => void;
  readonly state: (peer: ManagedPeer) => void;
  readonly negotiationError: (peer: ManagedPeer) => void;
}

interface IceCandidateStat {
  readonly id?: string;
  readonly type?: string;
  readonly candidateType?: string;
  readonly url?: string;
}

interface IcePairStat {
  readonly id?: string;
  readonly type?: string;
  readonly state?: string;
  readonly nominated?: boolean;
  readonly selected?: boolean;
  readonly localCandidateId?: string;
  readonly selectedCandidatePairId?: string;
}

const RESTART_COOLDOWN_MS = 10_000;
const TIER_EVENT_DEBOUNCE_MS = 1_000;

function statsValues(report: RTCStatsReport): readonly IcePairStat[] {
  const values: IcePairStat[] = [];
  report.forEach((value) => values.push(value as IcePairStat));
  return values;
}

export function classifySelectedIcePath(
  report: RTCStatsReport,
  activeTier: 0 | 1 | 2,
  edgeUrls: ReadonlySet<string>,
): IcePathClass {
  const values = statsValues(report);
  const byId = new Map(values.filter((stat) => stat.id).map((stat) => [stat.id!, stat]));
  const transport = values.find((stat) => stat.type === "transport" && stat.selectedCandidatePairId);
  const pair = (transport?.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : undefined)
    || values.find((stat) => stat.type === "candidate-pair" && stat.selected === true)
    || values.find((stat) => stat.type === "candidate-pair" && stat.nominated === true && stat.state === "succeeded");
  const local = pair?.localCandidateId ? byId.get(pair.localCandidateId) as IceCandidateStat | undefined : undefined;
  if (!local?.candidateType) return "unknown";
  if (local.candidateType !== "relay") return "direct";
  if (local.url && edgeUrls.has(local.url)) return "peer-edge";
  return activeTier === 1 ? "peer-edge" : "infrastructure-relay";
}

export class PeerConnectionManager {
  readonly peers = new Map<string, ManagedPeer>();

  constructor(
    private readonly ownPeerId: string,
    private readonly icePolicy: IceTierPolicy,
    private readonly dataOverlayEnabled: boolean,
    private readonly callbacks: ManagerCallbacks,
  ) {}

  add(peerId: string, name: string): ManagedPeer | null {
    if (!peerId || peerId === this.ownPeerId) return null;
    const current = this.peers.get(peerId);
    if (current) return current;
    const pc = new RTCPeerConnection({ iceServers: [...cumulativeIceServers(this.icePolicy, 0)] });
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
      iceTier: 0,
      icePath: "unknown",
      iceStartedAt: Date.now(),
      fallbackTimer: null,
      lastIceRestartAt: 0,
    };
    this.peers.set(peerId, peer);
    pc.onicecandidate = ({ candidate }) => this.callbacks.signal(peerId, { candidate });
    pc.ontrack = ({ track, receiver }) => this.callbacks.track(peer, track, receiver);
    pc.ondatachannel = ({ channel }) => this.callbacks.channel(peer, channel);
    pc.oniceconnectionstatechange = () => this.handleConnectionState(peer);
    pc.onconnectionstatechange = () => this.handleConnectionState(peer);
    pc.onnegotiationneeded = () => void this.negotiate(peer);
    if (this.ownPeerId < peerId) {
      this.callbacks.channel(peer, pc.createDataChannel("control", { ordered: true }));
      this.callbacks.channel(peer, pc.createDataChannel("chat", { ordered: true }));
      if (this.dataOverlayEnabled) {
        this.callbacks.channel(peer, pc.createDataChannel("overlay", { ordered: false, maxRetransmits: 3 }));
      }
    }
    this.scheduleFallback(peer);
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
    this.clearFallback(peer);
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

  private handleConnectionState(peer: ManagedPeer): void {
    const connected = new Set(["connected", "completed"]);
    if (connected.has(peer.pc.iceConnectionState) || peer.pc.connectionState === "connected") {
      this.clearFallback(peer);
      void this.detectIcePath(peer);
    } else if (peer.pc.iceConnectionState === "failed" || peer.pc.connectionState === "failed") {
      this.activateNextTier(peer);
    } else if (peer.pc.iceConnectionState === "disconnected" && !peer.fallbackTimer) {
      peer.fallbackTimer = setTimeout(() => this.activateNextTier(peer), 1_500);
    }
    this.callbacks.state(peer);
  }

  private scheduleFallback(peer: ManagedPeer): void {
    this.clearFallback(peer);
    if (peer.pc.connectionState === "closed" || peer.iceTier === 2) return;
    const nextTier = peer.iceTier === 0 && this.icePolicy.peerRelayIceServers.length > 0 ? 1 : 2;
    if (nextTier === 2 && this.icePolicy.infrastructureRelayIceServers.length === 0) return;
    const deadline = peer.iceStartedAt + (nextTier === 1
      ? this.icePolicy.peerRelayAfterMs
      : this.icePolicy.infrastructureRelayAfterMs);
    peer.fallbackTimer = setTimeout(() => this.activateTier(peer, nextTier), Math.max(0, deadline - Date.now()));
  }

  private activateNextTier(peer: ManagedPeer): void {
    const now = Date.now();
    if (peer.lastIceRestartAt > 0 && now - peer.lastIceRestartAt < TIER_EVENT_DEBOUNCE_MS) return;
    if (peer.iceTier === 0 && this.icePolicy.peerRelayIceServers.length > 0) {
      this.activateTier(peer, 1);
      return;
    }
    if (peer.iceTier < 2 && this.icePolicy.infrastructureRelayIceServers.length > 0) {
      this.activateTier(peer, 2);
      return;
    }
    if (now - peer.lastIceRestartAt >= RESTART_COOLDOWN_MS && peer.pc.connectionState !== "closed") {
      peer.lastIceRestartAt = now;
      peer.pc.restartIce();
    }
  }

  private activateTier(peer: ManagedPeer, tier: 1 | 2): void {
    if (tier <= peer.iceTier || peer.pc.connectionState === "closed") return;
    this.clearFallback(peer);
    peer.iceTier = tier;
    peer.lastIceRestartAt = Date.now();
    peer.pc.setConfiguration({ iceServers: [...cumulativeIceServers(this.icePolicy, tier)] });
    peer.pc.restartIce();
    this.callbacks.state(peer);
    this.scheduleFallback(peer);
  }

  private clearFallback(peer: ManagedPeer): void {
    if (peer.fallbackTimer) clearTimeout(peer.fallbackTimer);
    peer.fallbackTimer = null;
  }

  private async detectIcePath(peer: ManagedPeer): Promise<void> {
    try {
      peer.icePath = classifySelectedIcePath(
        await peer.pc.getStats(),
        peer.iceTier,
        iceServerUrls(this.icePolicy.peerRelayIceServers),
      );
      this.callbacks.state(peer);
    } catch {
      peer.icePath = "unknown";
    }
  }
}
