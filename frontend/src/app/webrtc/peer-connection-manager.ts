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
  /** [sigdbg] Mesh-level context (signaling socket, membership, gates) for a peer line. */
  readonly diagnostics?: (peerId: string) => Record<string, unknown>;
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
  // [sigdbg] signaling/negotiation lifecycle counters, diagnostics only.
  readonly createdAt: number;
  readonly createdChannels: string[];
  negotiationNeeded: number;
  negotiateSkipped: number;
  lastNegotiateSkip: string;
  offersSent: number;
  answersSent: number;
  offersReceived: number;
  answersReceived: number;
  offersIgnored: number;
  localDescriptionSet: number;
  remoteDescriptionSet: number;
  descriptionErrors: number;
  lastError: string;
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
  // [sigdbg] throttled per-peer signaling heartbeat while the peer is not connected.
  private signalHeartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly signalHeartbeatSeen = new Map<string, Readonly<{ line: string; at: number }>>();

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
    const diagnostics = this.diagnosticsFor(peer);
    this.logSignalEvent(peer, "peer-connection-created", {
      ownPeerId: this.ownPeerId,
      polite: peer.polite,
      dataOverlayEnabled: this.dataOverlayEnabled,
      baseChannelInitiator: this.ownPeerId < peerId,
      overlayInitiates: this.overlayInitiates(peerId),
      iceServers: this.configuredIceServerUrls(peer),
      peers: this.peers.size,
    });
    pc.onicecandidate = ({ candidate }) => {
      this.countCandidate(peer, "local", candidate?.candidate);
      this.callbacks.signal(peerId, { candidate });
    };
    pc.ontrack = ({ track, receiver }) => this.callbacks.track(peer, track, receiver);
    pc.ondatachannel = ({ channel }) => {
      this.logSignalEvent(peer, "datachannel-received", {
        label: channel.label,
        origin: "remote",
        readyState: channel.readyState,
      });
      this.callbacks.channel(peer, channel);
    };
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
      const candidateFailure = {
        errorCode: failure.errorCode,
        errorText: failure.errorText,
        url: failure.url,
        address: failure.address,
        port: failure.port,
      };
      this.logPeerEvent(peer, "icecandidateerror", candidateFailure);
      this.logSignalEvent(peer, "icecandidateerror", {
        ...candidateFailure,
        candidateErrors: this.diagnosticsFor(peer).candidateErrors,
      });
    };
    pc.onnegotiationneeded = () => {
      diagnostics.negotiationNeeded += 1;
      this.logSignalEvent(peer, "negotiationneeded", { count: diagnostics.negotiationNeeded });
      void this.negotiate(peer);
    };
    if (this.ownPeerId < peerId) {
      this.createLocalChannel(peer, "control", { ordered: true });
      this.createLocalChannel(peer, "chat", { ordered: true });
      this.createLocalChannel(peer, "captions", { ordered: true });
    }
    // Exactly one side creates the overlay channel. A limited machine peer must
    // own it so a human peer always receives the rekey transport it cannot be
    // trusted to create; otherwise the lower peer id stays the deterministic
    // owner. Never both: replace-on-adopt would close the shared channel.
    if (this.dataOverlayEnabled && this.overlayInitiates(peerId)) {
      this.createLocalChannel(peer, "overlay", { ordered: false, maxRetransmits: 3 });
    }
    // [sigdbg] Nothing below the guard creates an offer. A peer that owns no
    // channel and no sender never fires onnegotiationneeded and stays "new"
    // until the remote side offers; the heartbeat makes that visible.
    if (diagnostics.createdChannels.length === 0) {
      this.logSignalEvent(peer, "no-local-initiator", {
        reason: this.dataOverlayEnabled ? "not-channel-owner" : "overlay-disabled-and-not-channel-owner",
        awaiting: "remote-offer",
      });
    }
    this.scheduleFallback(peer);
    this.startSignalHeartbeat();
    return peer;
  }

  /** [sigdbg] Identical to the previous inline call, with the label recorded. */
  private createLocalChannel(peer: ManagedPeer, label: PeerChannelKind, init: RTCDataChannelInit): void {
    const channel = peer.pc.createDataChannel(label, init);
    this.diagnosticsFor(peer).createdChannels.push(label);
    this.logSignalEvent(peer, "datachannel-created", { label, origin: "local", readyState: channel.readyState });
    this.callbacks.channel(peer, channel);
  }

  async acceptSignal(message: ServerMessage): Promise<void> {
    const from = String(message["from"] || "");
    const known = this.peers.has(from);
    const peer = this.add(from, String(message["fromName"] || "Peer"));
    if (!peer) return;
    const diagnostics = this.diagnosticsFor(peer);
    try {
      const description = message["description"] as RTCSessionDescriptionInit | undefined;
      if (description) {
        if (description.type === "offer") diagnostics.offersReceived += 1;
        else if (description.type === "answer") diagnostics.answersReceived += 1;
        const readyForOffer = !peer.makingOffer
          && (peer.pc.signalingState === "stable" || peer.settingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;
        peer.ignoreOffer = !peer.polite && offerCollision;
        this.logSignalEvent(peer, "description-received", {
          type: description.type,
          createdPeerConnection: !known,
          polite: peer.polite,
          makingOffer: peer.makingOffer,
          settingRemoteAnswerPending: peer.settingRemoteAnswerPending,
          readyForOffer,
          offerCollision,
          ignoreOffer: peer.ignoreOffer,
        });
        if (peer.ignoreOffer) {
          diagnostics.offersIgnored += 1;
          this.logSignalEvent(peer, "offer-ignored", { count: diagnostics.offersIgnored });
          return;
        }
        if (offerCollision) peer.needsNegotiation = true;
        peer.settingRemoteAnswerPending = description.type === "answer";
        await peer.pc.setRemoteDescription(description);
        peer.settingRemoteAnswerPending = false;
        diagnostics.remoteDescriptionSet += 1;
        this.logSignalEvent(peer, "remote-description-set", { type: description.type });
        if (description.type === "offer") {
          await peer.pc.setLocalDescription();
          this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
          diagnostics.localDescriptionSet += 1;
          diagnostics.answersSent += 1;
          this.logSignalEvent(peer, "answer-sent", { type: peer.pc.localDescription?.type ?? null });
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
    this.logSignalEvent(peer, "peer-connection-removed", {
      channels: this.channelStates(peer),
      hypothesis: this.hypothesis(peer),
    });
    this.signalHeartbeatSeen.delete(peerId);
    this.clearFallback(peer);
    for (const channel of peer.channels.values()) channel.close();
    peer.pc.close();
    this.peers.delete(peerId);
    return peer;
  }

  close(): void {
    for (const peerId of [...this.peers.keys()]) this.remove(peerId);
    this.stopSignalHeartbeat();
  }

  private async negotiate(peer: ManagedPeer): Promise<void> {
    const diagnostics = this.diagnosticsFor(peer);
    peer.needsNegotiation = true;
    if (peer.makingOffer || peer.pc.signalingState !== "stable") {
      diagnostics.negotiateSkipped += 1;
      diagnostics.lastNegotiateSkip = peer.makingOffer
        ? "making-offer"
        : "signaling-state:" + peer.pc.signalingState;
      this.logSignalEvent(peer, "negotiate-skipped", { reason: diagnostics.lastNegotiateSkip });
      return;
    }
    peer.needsNegotiation = false;
    peer.makingOffer = true;
    let offerCreated = false;
    try {
      await peer.pc.setLocalDescription();
      this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
      offerCreated = true;
      diagnostics.localDescriptionSet += 1;
      diagnostics.offersSent += 1;
      this.logSignalEvent(peer, "offer-sent", {
        type: peer.pc.localDescription?.type ?? null,
        count: diagnostics.offersSent,
      });
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
      createdAt: Date.now(),
      createdChannels: [],
      negotiationNeeded: 0,
      negotiateSkipped: 0,
      lastNegotiateSkip: "",
      offersSent: 0,
      answersSent: 0,
      offersReceived: 0,
      answersReceived: 0,
      offersIgnored: 0,
      localDescriptionSet: 0,
      remoteDescriptionSet: 0,
      descriptionErrors: 0,
      lastError: "",
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
    const described = describeNegotiationError(error);
    diagnostics.descriptionErrors += 1;
    diagnostics.lastError = phase + ":" + described.name + ":" + described.message.slice(0, 120);
    this.logSignalEvent(peer, "negotiation-failed", {
      phase,
      polite: peer.polite,
      makingOffer: peer.makingOffer,
      ignoreOffer: peer.ignoreOffer,
      needsNegotiation: peer.needsNegotiation,
      error: described,
    });
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

  /**
   * [sigdbg] Diagnostics only. Nothing in this block touches negotiation, ICE
   * tiers or media; it exists so the companion log can tell "never offered"
   * from "offered and ignored" from "offered and ICE never connected".
   */
  private channelStates(peer: ManagedPeer): readonly string[] {
    return [...peer.channels.entries()].map(([kind, channel]) => kind + ":" + channel.readyState);
  }

  /**
   * A single named guess per peer, derived from the observable state only.
   * `awaiting-remote-offer` means this side is a pure responder: it created no
   * channel and holds no sender, so onnegotiationneeded cannot fire here.
   */
  private hypothesis(peer: ManagedPeer): string {
    const diagnostics = this.diagnosticsFor(peer);
    const pc = peer.pc;
    if (pc.connectionState === "closed" || pc.signalingState === "closed") return "closed";
    if (pc.connectionState === "connected") return "connected";
    if (pc.connectionState === "failed" || pc.iceConnectionState === "failed") return "ice-failed";
    if (diagnostics.descriptionErrors > 0 && !pc.remoteDescription) return "description-rejected";
    if (pc.signalingState === "have-local-offer") return "offer-sent-awaiting-answer";
    if (pc.signalingState === "have-remote-offer") return "remote-offer-not-answered";
    if (!pc.localDescription && !pc.remoteDescription) {
      if (diagnostics.offersIgnored > 0) return "offer-ignored-no-retry";
      if (diagnostics.negotiationNeeded === 0) {
        return diagnostics.createdChannels.length === 0 && peer.senders.size === 0
          ? "awaiting-remote-offer"
          : "negotiationneeded-never-fired";
      }
      return diagnostics.offersSent === 0 ? "negotiationneeded-but-no-offer-sent" : "offer-sent-but-state-reset";
    }
    if (pc.localDescription && pc.remoteDescription) return "descriptions-exchanged-ice-not-connected";
    return "partial-description";
  }

  /** Stable fields only: `at`/`ageMs` are added by the caller so repeats dedupe. */
  private signalSnapshot(peer: ManagedPeer): Record<string, unknown> {
    const diagnostics = this.diagnosticsFor(peer);
    const pc = peer.pc;
    return {
      event: "peer-signaling",
      peer: peer.id,
      name: peer.name,
      ownPeerId: this.ownPeerId,
      polite: peer.polite,
      signalingState: pc.signalingState,
      iceConnectionState: pc.iceConnectionState,
      connectionState: pc.connectionState,
      iceGatheringState: pc.iceGatheringState,
      iceTier: peer.iceTier,
      icePath: peer.icePath,
      localDescription: pc.localDescription?.type ?? null,
      remoteDescription: pc.remoteDescription?.type ?? null,
      channelsCreated: [...diagnostics.createdChannels],
      channels: this.channelStates(peer),
      senders: peer.senders.size,
      dataOverlayEnabled: this.dataOverlayEnabled,
      baseChannelInitiator: this.ownPeerId < peer.id,
      overlayInitiates: this.overlayInitiates(peer.id),
      makingOffer: peer.makingOffer,
      needsNegotiation: peer.needsNegotiation,
      ignoreOffer: peer.ignoreOffer,
      settingRemoteAnswerPending: peer.settingRemoteAnswerPending,
      negotiationNeeded: diagnostics.negotiationNeeded,
      negotiateSkipped: diagnostics.negotiateSkipped,
      lastNegotiateSkip: diagnostics.lastNegotiateSkip,
      offersSent: diagnostics.offersSent,
      answersSent: diagnostics.answersSent,
      offersReceived: diagnostics.offersReceived,
      answersReceived: diagnostics.answersReceived,
      offersIgnored: diagnostics.offersIgnored,
      localDescriptionSet: diagnostics.localDescriptionSet,
      remoteDescriptionSet: diagnostics.remoteDescriptionSet,
      descriptionErrors: diagnostics.descriptionErrors,
      lastError: diagnostics.lastError,
      localCandidates: diagnostics.local,
      remoteCandidates: diagnostics.remote,
      candidateErrors: diagnostics.candidateErrors,
      iceServers: this.configuredIceServerUrls(peer),
      hypothesis: this.hypothesis(peer),
      ...(this.callbacks.diagnostics?.(peer.id) ?? {}),
    };
  }

  private startSignalHeartbeat(): void {
    if (this.signalHeartbeat) return;
    this.signalHeartbeat = setInterval(() => this.logSignalHeartbeat(), 1_000);
  }

  private stopSignalHeartbeat(): void {
    if (this.signalHeartbeat) clearInterval(this.signalHeartbeat);
    this.signalHeartbeat = null;
    this.signalHeartbeatSeen.clear();
  }

  /**
   * One line per peer per second while `connectionState` is not `connected`;
   * an unchanged snapshot is suppressed until it changes or 5 s elapse, so a
   * long stall stays readable in the companion log instead of flooding it.
   */
  private logSignalHeartbeat(): void {
    const now = Date.now();
    for (const peerId of [...this.signalHeartbeatSeen.keys()]) {
      if (!this.peers.has(peerId)) this.signalHeartbeatSeen.delete(peerId);
    }
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState === "connected") {
        this.signalHeartbeatSeen.delete(peer.id);
        continue;
      }
      const state = this.signalSnapshot(peer);
      const line = JSON.stringify(state);
      const seen = this.signalHeartbeatSeen.get(peer.id);
      if (seen && seen.line === line && now - seen.at < 5_000) continue;
      this.signalHeartbeatSeen.set(peer.id, { line, at: now });
      console.warn("[sigdbg] " + JSON.stringify({
        at: new Date(now).toISOString(),
        ageMs: now - this.diagnosticsFor(peer).createdAt,
        ...state,
      }));
    }
    if (this.peers.size === 0) this.stopSignalHeartbeat();
  }

  private logSignalEvent(peer: ManagedPeer, event: string, detail: Record<string, unknown> = {}): void {
    console.warn("[sigdbg] " + JSON.stringify({
      at: new Date().toISOString(),
      event,
      peer: peer.id,
      name: peer.name,
      signalingState: peer.pc.signalingState,
      iceConnectionState: peer.pc.iceConnectionState,
      connectionState: peer.pc.connectionState,
      iceGatheringState: peer.pc.iceGatheringState,
      ...detail,
      ...(this.callbacks.diagnostics?.(peer.id) ?? {}),
    }));
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
