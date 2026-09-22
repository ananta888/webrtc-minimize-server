import { LinkClass } from "./media-optimization-policy";
import {
  cumulativeIceServers,
  IcePathClass,
  IceTierPolicy,
  iceServerUrls,
} from "./ice-policy";
import { ServerMessage } from "./signaling.service";

export type PeerChannelKind = "captions" | "chat" | "control" | "overlay";

export interface ManagedPeer {
  readonly id: string;
  readonly name: string;
  readonly pc: RTCPeerConnection;
  readonly channels: Map<PeerChannelKind, RTCDataChannel>;
  readonly senders: Map<string, RTCRtpSender>;
  readonly appliedTiers: Map<string, string>;
  makingOffer: boolean;
  needsNegotiation: boolean;
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
  readonly negotiationError: (peer: ManagedPeer, error?: unknown) => void;
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

/**
 * Diagnostics only ([negdbg]). Nothing below influences negotiation, ICE tiers
 * or media; it exists to explain a failed handshake in the companion log.
 */
const CANDIDATE_KINDS = ["host", "srflx", "prflx", "relay", "unknown"] as const;

type IceCandidateKind = typeof CANDIDATE_KINDS[number];

type CandidateCounts = Record<IceCandidateKind, number>;

interface NegotiationDiagnostics {
  readonly local: CandidateCounts;
  readonly remote: CandidateCounts;
  candidateErrors: number;
}

function emptyCandidateCounts(): CandidateCounts {
  return { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
}

function candidateKind(candidate: string): IceCandidateKind {
  const parsed = /\btyp (host|srflx|prflx|relay)\b/.exec(candidate)?.[1];
  return (parsed as IceCandidateKind | undefined) ?? "unknown";
}

/**
 * A rejected description can quote SDP back. Keep ephemeral session secrets out
 * of the log and bound the line length; TURN credentials are never read here.
 */
export function describeNegotiationError(error: unknown): Readonly<{ name: string; message: string }> {
  if (error === undefined || error === null) return { name: "unknown", message: "no error value captured" };
  const source = error instanceof Error ? error : null;
  const message = source ? source.message : String(error);
  return {
    name: source ? source.name : typeof error,
    message: message
      .replace(/(ice-pwd:|ice-ufrag:|fingerprint:)\S+/gi, "$1<redacted>")
      .slice(0, 400),
  };
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
  // [negdbg] per-peer counters; a WeakMap keeps ManagedPeer and its teardown untouched.
  private readonly negotiationDiagnostics = new WeakMap<ManagedPeer, NegotiationDiagnostics>();

  constructor(
    private readonly ownPeerId: string,
    private readonly icePolicy: IceTierPolicy,
    private readonly dataOverlayEnabled: boolean,
    private readonly callbacks: ManagerCallbacks,
    private readonly overlayInitiates: (peerId: string) => boolean = (peerId) => ownPeerId < peerId,
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
      needsNegotiation: false,
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
    pc.onicecandidate = ({ candidate }) => {
      this.countCandidate(peer, "local", candidate?.candidate);
      this.callbacks.signal(peerId, { candidate });
    };
    pc.ontrack = ({ track, receiver }) => this.callbacks.track(peer, track, receiver);
    pc.ondatachannel = ({ channel }) => this.callbacks.channel(peer, channel);
    pc.oniceconnectionstatechange = () => {
      this.logPeerEvent(peer, "iceconnectionstatechange");
      this.handleConnectionState(peer);
    };
    pc.onconnectionstatechange = () => {
      this.logPeerEvent(peer, "connectionstatechange");
      this.handleConnectionState(peer);
    };
    pc.onicegatheringstatechange = () => this.logPeerEvent(peer, "icegatheringstatechange");
    pc.onicecandidateerror = (event) => {
      const failure = event as RTCPeerConnectionIceErrorEvent;
      this.diagnosticsFor(peer).candidateErrors += 1;
      this.logPeerEvent(peer, "icecandidateerror", {
        errorCode: failure.errorCode,
        errorText: failure.errorText,
        url: failure.url,
        address: failure.address,
        port: failure.port,
      });
    };
    pc.onnegotiationneeded = () => void this.negotiate(peer);
    if (this.ownPeerId < peerId) {
      this.callbacks.channel(peer, pc.createDataChannel("control", { ordered: true }));
      this.callbacks.channel(peer, pc.createDataChannel("chat", { ordered: true }));
      this.callbacks.channel(peer, pc.createDataChannel("captions", { ordered: true }));
    }
    // Exactly one side creates the overlay channel. A limited machine peer must
    // own it so a human peer always receives the rekey transport it cannot be
    // trusted to create; otherwise the lower peer id stays the deterministic
    // owner. Never both: replace-on-adopt would close the shared channel.
    if (this.dataOverlayEnabled && this.overlayInitiates(peerId)) {
      this.callbacks.channel(peer, pc.createDataChannel("overlay", { ordered: false, maxRetransmits: 3 }));
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
        if (offerCollision) peer.needsNegotiation = true;
        peer.settingRemoteAnswerPending = description.type === "answer";
        await peer.pc.setRemoteDescription(description);
        peer.settingRemoteAnswerPending = false;
        if (description.type === "offer") {
          await peer.pc.setLocalDescription();
          this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
        }
        if (peer.needsNegotiation && peer.pc.signalingState === "stable") {
          void this.negotiate(peer);
        }
        return;
      }
      const candidate = (message["candidate"] as RTCIceCandidateInit | null) ?? null;
      this.countCandidate(peer, "remote", candidate?.candidate);
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!peer.ignoreOffer) throw error;
      }
    } catch (error) {
      peer.settingRemoteAnswerPending = false;
      this.reportNegotiationError(peer, "accept-signal", error);
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
    peer.needsNegotiation = true;
    if (peer.makingOffer || peer.pc.signalingState !== "stable") return;
    peer.needsNegotiation = false;
    peer.makingOffer = true;
    let offerCreated = false;
    try {
      await peer.pc.setLocalDescription();
      this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
      offerCreated = true;
    } catch (error) {
      peer.needsNegotiation = true;
      this.reportNegotiationError(peer, "create-offer", error);
    } finally {
      peer.makingOffer = false;
      if (offerCreated && peer.needsNegotiation && peer.pc.signalingState === "stable") {
        queueMicrotask(() => void this.negotiate(peer));
      }
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

  private diagnosticsFor(peer: ManagedPeer): NegotiationDiagnostics {
    const current = this.negotiationDiagnostics.get(peer);
    if (current) return current;
    const created: NegotiationDiagnostics = {
      local: emptyCandidateCounts(),
      remote: emptyCandidateCounts(),
      candidateErrors: 0,
    };
    this.negotiationDiagnostics.set(peer, created);
    return created;
  }

  private countCandidate(peer: ManagedPeer, side: "local" | "remote", candidate: string | undefined): void {
    if (!candidate) return; // The null candidate only marks the end of gathering.
    const diagnostics = this.diagnosticsFor(peer);
    const counts = side === "local" ? diagnostics.local : diagnostics.remote;
    counts[candidateKind(candidate)] += 1;
  }

  /** ICE server urls only: usernames and TURN credentials must never be logged. */
  private configuredIceServerUrls(peer: ManagedPeer): readonly string[] {
    return [...iceServerUrls(cumulativeIceServers(this.icePolicy, peer.iceTier))];
  }

  private peerStates(peer: ManagedPeer): Record<string, unknown> {
    return {
      iceConnectionState: peer.pc.iceConnectionState,
      connectionState: peer.pc.connectionState,
      signalingState: peer.pc.signalingState,
      iceGatheringState: peer.pc.iceGatheringState,
      iceTier: peer.iceTier,
      icePath: peer.icePath,
    };
  }

  private logPeerEvent(peer: ManagedPeer, event: string, detail: Record<string, unknown> = {}): void {
    console.warn("[negdbg] " + JSON.stringify({
      at: new Date().toISOString(),
      event,
      peer: peer.id,
      name: peer.name,
      ...this.peerStates(peer),
      ...detail,
    }));
  }

  private reportNegotiationError(peer: ManagedPeer, phase: string, error: unknown): void {
    const diagnostics = this.diagnosticsFor(peer);
    this.logPeerEvent(peer, "negotiation-failed", {
      phase,
      polite: peer.polite,
      makingOffer: peer.makingOffer,
      ignoreOffer: peer.ignoreOffer,
      needsNegotiation: peer.needsNegotiation,
      error: describeNegotiationError(error),
      iceServers: this.configuredIceServerUrls(peer),
      localCandidates: diagnostics.local,
      remoteCandidates: diagnostics.remote,
      candidateErrors: diagnostics.candidateErrors,
    });
    this.callbacks.negotiationError(peer, error);
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
