import { LinkClass } from "./media-optimization-policy";
import {
  cumulativeIceServers,
  IcePathClass,
  IceTierPolicy,
  iceServerUrls,
} from "./ice-policy";
import { IcePolicySource } from "./ice-credential-refresher";
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
  staleAnswersIgnored: number;
  localOffersRolledBack: number;
  offersUnanswered: number;
  localDescriptionSet: number;
  remoteDescriptionSet: number;
  descriptionErrors: number;
  lastError: string;
  remoteCandidateErrors: number;
  // `${url}#${errorCode}` -> count; urls only, never usernames or addresses.
  readonly candidateErrorsByUrl: Record<string, number>;
}

/**
 * Perfect-negotiation bookkeeping that is not part of ManagedPeer, so the
 * media-agent connections extending it stay untouched.
 */
interface NegotiationControl {
  // Descriptions and candidates of one peer are applied strictly in arrival order.
  signalQueue: Promise<void>;
  // Resolves once a local setLocalDescription(offer) has settled.
  offerInFlight: Promise<void> | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
  unansweredStreak: number;
  // Compared only to detect a remote ICE restart; never logged.
  remoteIceUfrag: string;
  remoteIceRestartAt: number;
  deferredRestartTimer: ReturnType<typeof setTimeout> | null;
  // Self-healing after the last ICE tier: fresh credentials plus an ICE restart.
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  recoveryAttempt: number;
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
 * of the log; the message itself stays complete because the decisive part of a
 * libwebrtc "Session error description" sits at its end. TURN credentials are
 * never read here.
 */
export function describeNegotiationError(error: unknown): Readonly<{ name: string; message: string }> {
  if (error === undefined || error === null) return { name: "unknown", message: "no error value captured" };
  const source = error instanceof Error ? error : null;
  const message = source ? source.message : String(error);
  return {
    name: source ? source.name : typeof error,
    message: message.replace(/(ice-pwd:|ice-ufrag:|fingerprint:)\S+/gi, "$1<redacted>"),
  };
}

/** First ice-ufrag of an SDP; only compared to detect a remote ICE restart. */
function sdpIceUfrag(sdp: string | undefined): string {
  return /^a=ice-ufrag:(\S+)/m.exec(sdp || "")?.[1] ?? "";
}

const RESTART_COOLDOWN_MS = 10_000;
const TIER_EVENT_DEBOUNCE_MS = 1_000;
// An offer that neither got answered nor collided is rolled back and re-offered;
// the backoff doubles per consecutive stall so a dead peer never causes a tight loop.
export const OFFER_ANSWER_TIMEOUT_MS = 8_000;
const OFFER_ANSWER_TIMEOUT_MAX_MS = 60_000;
// The impolite side waits this long for the polite side's ICE-restart offer
// before restarting itself, so a tier step never produces two crossing offers.
export const ICE_RESTART_GRACE_MS = 2_000;
// A peer that is still not connected on its last ICE tier (stuck in new/checking,
// failed or disconnected) is restarted with fresh TURN credentials. The delay
// doubles per attempt up to the cap and resets once the peer connects, so a
// long-lived tab or companion recovers without a restart storm.
export const ICE_RECOVERY_BASE_MS = 10_000;
export const ICE_RECOVERY_MAX_MS = 120_000;
const ANSWER_CREDENTIAL_WAIT_MS = 1_500;

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
  private readonly negotiationControl = new WeakMap<ManagedPeer, NegotiationControl>();
  // [sigdbg] throttled per-peer signaling heartbeat while the peer is not connected.
  private signalHeartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly signalHeartbeatSeen = new Map<string, Readonly<{ line: string; at: number }>>();

  // A fixed policy (tests, sessions without ephemeral TURN) keeps tier steps synchronous.
  private readonly policySource: IcePolicySource | null;
  private readonly fixedPolicy: IceTierPolicy | null;

  constructor(
    private readonly ownPeerId: string,
    icePolicy: IceTierPolicy | IcePolicySource,
    private readonly dataOverlayEnabled: boolean,
    private readonly callbacks: ManagerCallbacks,
    private readonly overlayInitiates: (peerId: string) => boolean = (peerId) => ownPeerId < peerId,
  ) {
    const source = "current" in icePolicy ? icePolicy : null;
    this.policySource = source;
    this.fixedPolicy = source ? null : icePolicy as IceTierPolicy;
  }

  private get icePolicy(): IceTierPolicy {
    return this.policySource ? this.policySource.current() : this.fixedPolicy!;
  }

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
      if (["connected", "disconnected", "failed"].includes(pc.connectionState)) {
        void this.logSelectedCandidatePair(peer, "connectionstatechange:" + pc.connectionState);
      }
    };
    pc.onicegatheringstatechange = () => {
      this.logPeerEvent(peer, "icegatheringstatechange");
      if (pc.iceGatheringState === "complete") this.logGatheringSummary(peer);
    };
    pc.onicecandidateerror = (event) => {
      const failure = event as RTCPeerConnectionIceErrorEvent;
      this.diagnosticsFor(peer).candidateErrors += 1;
      // The local interface address stays out of the log; its family is enough
      // to tell an IPv6-only STUN/TURN failure from a general one.
      const candidateFailure = {
        errorCode: failure.errorCode,
        errorText: failure.errorText,
        url: failure.url,
        addressFamily: !failure.address ? null : failure.address.includes(":") ? "ipv6" : "ipv4",
        port: failure.port,
      };
      const byUrl = this.diagnosticsFor(peer).candidateErrorsByUrl;
      const key = (failure.url || "no-url") + "#" + failure.errorCode;
      byUrl[key] = (byUrl[key] ?? 0) + 1;
      this.logPeerEvent(peer, "icecandidateerror", candidateFailure);
      this.logSignalEvent(peer, "icecandidateerror", {
        ...candidateFailure,
        candidateErrors: this.diagnosticsFor(peer).candidateErrors,
      });
      this.logMediaEvent(peer, "icecandidateerror", { ...candidateFailure, candidateErrorsByUrl: byUrl });
    };
    pc.onnegotiationneeded = () => {
      diagnostics.negotiationNeeded += 1;
      this.logSignalEvent(peer, "negotiationneeded", { count: diagnostics.negotiationNeeded });
      this.logMediaEvent(peer, "negotiationneeded", {
        count: diagnostics.negotiationNeeded,
        makingOffer: peer.makingOffer,
        needsNegotiation: peer.needsNegotiation,
        transceivers: this.transceiverSummary(peer),
      });
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
    if (!this.nextFallback(peer)) this.armRecovery(peer, "no-relay-tier");
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

  /**
   * Signals of one peer are applied strictly in arrival order. The socket
   * dispatches them without awaiting, so without this queue a candidate or a
   * second description could run against a half-applied offer.
   */
  acceptSignal(message: ServerMessage): Promise<void> {
    const from = String(message["from"] || "");
    const known = this.peers.has(from);
    const peer = this.add(from, String(message["fromName"] || "Peer"));
    if (!peer) return Promise.resolve();
    const control = this.controlFor(peer);
    const applied = control.signalQueue.then(() => this.applySignal(peer, message, known));
    control.signalQueue = applied.catch(() => undefined);
    return applied;
  }

  private async applySignal(peer: ManagedPeer, message: ServerMessage, known: boolean): Promise<void> {
    if (peer.pc.signalingState === "closed") return;
    const diagnostics = this.diagnosticsFor(peer);
    const control = this.controlFor(peer);
    try {
      const description = message["description"] as RTCSessionDescriptionInit | undefined;
      if (description) {
        if (description.type === "offer") diagnostics.offersReceived += 1;
        else if (description.type === "answer") diagnostics.answersReceived += 1;
        if (description.type === "answer" && peer.pc.signalingState !== "have-local-offer") {
          // Our offer was rolled back (collision or answer timeout) before this
          // answer arrived. Applying it would only fail with InvalidStateError;
          // the pending renegotiation supersedes it.
          diagnostics.staleAnswersIgnored += 1;
          this.logSignalEvent(peer, "stale-answer-ignored", { count: diagnostics.staleAnswersIgnored });
          return;
        }
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
        if (offerCollision) {
          // Polite glare resolution: roll our own offer back explicitly instead
          // of relying on setRemoteDescription's implicit rollback, which is the
          // path that failed live with "Failed to set remote offer sdp". Our
          // changes are re-offered once the remote offer is answered.
          peer.needsNegotiation = true;
          await this.rollbackLocalOffer(peer, "offer-collision");
        }
        if (description.type === "offer") {
          const pulledForward = this.noteRemoteIceRestart(peer, description.sdp);
          if (pulledForward) await pulledForward;
        }
        peer.settingRemoteAnswerPending = description.type === "answer";
        await peer.pc.setRemoteDescription(description);
        peer.settingRemoteAnswerPending = false;
        diagnostics.remoteDescriptionSet += 1;
        control.remoteIceUfrag = sdpIceUfrag(description.sdp) || control.remoteIceUfrag;
        this.logSignalEvent(peer, "remote-description-set", { type: description.type });
        if (description.type === "answer") {
          this.clearOfferTimer(peer);
          control.unansweredStreak = 0;
        }
        if (description.type === "offer") {
          await peer.pc.setLocalDescription();
          this.callbacks.signal(peer.id, { description: peer.pc.localDescription });
          diagnostics.localDescriptionSet += 1;
          diagnostics.answersSent += 1;
          this.logSignalEvent(peer, "answer-sent", { type: peer.pc.localDescription?.type ?? null });
        }
        this.logMediaEvent(peer, "description-applied", { type: description.type, offerCollision });
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
        // A candidate of an ignored or rolled-back offer generation is expected
        // to be rejected; it is diagnostic noise, not a failed negotiation.
        diagnostics.remoteCandidateErrors += 1;
        this.logSignalEvent(peer, "remote-candidate-rejected", {
          ignoreOffer: peer.ignoreOffer,
          remoteDescription: peer.pc.remoteDescription?.type ?? null,
          count: diagnostics.remoteCandidateErrors,
          error: describeNegotiationError(error),
        });
      }
    } catch (error) {
      peer.settingRemoteAnswerPending = false;
      this.reportNegotiationError(peer, "accept-signal", error);
      // A failed remote offer must not leave a stale local offer behind: the
      // remote side waits for an answer to its own offer, so re-offer from a
      // stable state and let the answer timeout break a mutual wait.
      if (peer.pc.signalingState === "have-remote-offer") {
        try { await peer.pc.setLocalDescription({ type: "rollback" }); } catch { /* reported above */ }
      }
      if (peer.needsNegotiation && peer.pc.signalingState === "stable") void this.negotiate(peer);
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
    this.clearOfferTimer(peer);
    this.clearDeferredRestart(peer);
    this.clearRecovery(peer);
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
    const control = this.controlFor(peer);
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
    const created = peer.pc.setLocalDescription();
    control.offerInFlight = created.then(() => undefined, () => undefined);
    try {
      await created;
      const offer = peer.pc.localDescription;
      // Re-read after the await: TypeScript would keep the pre-await "stable".
      const state = peer.pc.signalingState as RTCSignalingState;
      if (state !== "have-local-offer" || offer?.type !== "offer") {
        // A polite rollback won the race; the answer path re-offers.
        peer.needsNegotiation = true;
        this.logSignalEvent(peer, "offer-superseded", { localDescription: offer?.type ?? null });
        return;
      }
      this.callbacks.signal(peer.id, { description: offer });
      offerCreated = true;
      diagnostics.localDescriptionSet += 1;
      diagnostics.offersSent += 1;
      this.armOfferTimer(peer, offer);
      this.logSignalEvent(peer, "offer-sent", {
        type: offer.type,
        count: diagnostics.offersSent,
      });
    } catch (error) {
      peer.needsNegotiation = true;
      this.reportNegotiationError(peer, "create-offer", error);
    } finally {
      peer.makingOffer = false;
      control.offerInFlight = null;
      if (offerCreated && peer.needsNegotiation && peer.pc.signalingState === "stable") {
        queueMicrotask(() => void this.negotiate(peer));
      }
    }
  }

  /** Rolls a pending local offer back; waits for an offer that is still being created. */
  private async rollbackLocalOffer(peer: ManagedPeer, reason: string): Promise<boolean> {
    const control = this.controlFor(peer);
    if (control.offerInFlight) await control.offerInFlight;
    this.clearOfferTimer(peer);
    if (peer.pc.signalingState !== "have-local-offer") return false;
    await peer.pc.setLocalDescription({ type: "rollback" });
    const diagnostics = this.diagnosticsFor(peer);
    diagnostics.localOffersRolledBack += 1;
    this.logSignalEvent(peer, "local-offer-rolled-back", { reason, count: diagnostics.localOffersRolledBack });
    return true;
  }

  /**
   * Breaks a mutual wait: both sides in have-local-offer, the impolite side
   * ignoring ours and ours never answered (e.g. after a rejected remote offer).
   * Runs through the signal queue so it never interleaves with a description.
   */
  private armOfferTimer(peer: ManagedPeer, offer: RTCSessionDescription): void {
    const control = this.controlFor(peer);
    this.clearOfferTimer(peer);
    const delay = Math.min(OFFER_ANSWER_TIMEOUT_MS * 2 ** Math.min(control.unansweredStreak, 3),
      OFFER_ANSWER_TIMEOUT_MAX_MS);
    control.offerTimer = setTimeout(() => {
      control.offerTimer = null;
      control.signalQueue = control.signalQueue.then(async () => {
        if (peer.pc.signalingState !== "have-local-offer" || peer.pc.localDescription?.sdp !== offer.sdp) return;
        control.unansweredStreak += 1;
        const diagnostics = this.diagnosticsFor(peer);
        diagnostics.offersUnanswered += 1;
        this.logSignalEvent(peer, "offer-unanswered", {
          afterMs: delay,
          streak: control.unansweredStreak,
          count: diagnostics.offersUnanswered,
        });
        try {
          peer.needsNegotiation = true;
          await this.rollbackLocalOffer(peer, "answer-timeout");
        } catch (error) {
          this.reportNegotiationError(peer, "offer-timeout-rollback", error);
          return;
        }
        if ((peer.pc.signalingState as RTCSignalingState) === "stable") void this.negotiate(peer);
      }).catch(() => undefined);
    }, delay);
  }

  private clearOfferTimer(peer: ManagedPeer): void {
    const control = this.negotiationControl.get(peer);
    if (control?.offerTimer) clearTimeout(control.offerTimer);
    if (control) control.offerTimer = null;
  }

  private controlFor(peer: ManagedPeer): NegotiationControl {
    const current = this.negotiationControl.get(peer);
    if (current) return current;
    const created: NegotiationControl = {
      signalQueue: Promise.resolve(),
      offerInFlight: null,
      offerTimer: null,
      unansweredStreak: 0,
      remoteIceUfrag: "",
      remoteIceRestartAt: 0,
      deferredRestartTimer: null,
      recoveryTimer: null,
      recoveryAttempt: 0,
    };
    this.negotiationControl.set(peer, created);
    return created;
  }

  /**
   * A remote ICE-restart offer regathers our candidates with the configuration
   * active when we answer. While not connected, pull an imminent tier step
   * forward so the answer already carries its relay candidates, and cancel our
   * own deferred restart: the remote one already covers it.
   */
  private noteRemoteIceRestart(peer: ManagedPeer, sdp: string | undefined): Promise<void> | void {
    const control = this.controlFor(peer);
    const ufrag = sdpIceUfrag(sdp);
    if (!ufrag || !control.remoteIceUfrag || ufrag === control.remoteIceUfrag) return;
    control.remoteIceRestartAt = Date.now();
    this.clearDeferredRestart(peer);
    const next = this.nextFallback(peer);
    const connected = peer.pc.connectionState === "connected";
    const pulledForward = !connected && next !== null && next.deadline - Date.now() <= ICE_RESTART_GRACE_MS;
    this.logMediaEvent(peer, "remote-ice-restart", { connected, pulledForwardTier: pulledForward ? next!.tier : null });
    if (pulledForward) return this.boundAnswerDelay(this.activateTier(peer, next.tier, "none"));
    // The remote restart regathers us with the configuration active at our
    // answer; make sure that configuration does not carry expired credentials.
    if (!connected && peer.iceTier > 0 && this.policySource) {
      return this.boundAnswerDelay(this.applyFreshTier(peer, peer.iceTier, "remote-ice-restart"));
    }
  }

  /** A slow credential fetch must not hold the answer past the remote offer timeout. */
  private boundAnswerDelay(pending: Promise<void> | void): Promise<void> | void {
    if (!pending) return;
    return Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, ANSWER_CREDENTIAL_WAIT_MS))]);
  }

  private handleConnectionState(peer: ManagedPeer): void {
    const connected = new Set(["connected", "completed"]);
    if (connected.has(peer.pc.iceConnectionState) || peer.pc.connectionState === "connected") {
      this.clearFallback(peer);
      this.clearDeferredRestart(peer);
      this.clearRecovery(peer, true);
      void this.detectIcePath(peer);
    } else if (peer.pc.iceConnectionState === "failed" || peer.pc.connectionState === "failed") {
      this.activateNextTier(peer);
    } else if (peer.pc.iceConnectionState === "disconnected" && !peer.fallbackTimer) {
      peer.fallbackTimer = setTimeout(() => this.activateNextTier(peer), 1_500);
    }
    this.callbacks.state(peer);
  }

  private nextFallback(peer: ManagedPeer): Readonly<{ tier: 1 | 2; deadline: number }> | null {
    if (peer.pc.connectionState === "closed" || peer.iceTier === 2) return null;
    const tier = peer.iceTier === 0 && this.icePolicy.peerRelayIceServers.length > 0 ? 1 : 2;
    if (tier === 2 && this.icePolicy.infrastructureRelayIceServers.length === 0) return null;
    const deadline = peer.iceStartedAt + (tier === 1
      ? this.icePolicy.peerRelayAfterMs
      : this.icePolicy.infrastructureRelayAfterMs);
    return { tier, deadline };
  }

  private scheduleFallback(peer: ManagedPeer): void {
    this.clearFallback(peer);
    const next = this.nextFallback(peer);
    if (!next) return;
    peer.fallbackTimer = setTimeout(() => this.activateTier(peer, next.tier), Math.max(0, next.deadline - Date.now()));
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
      if (this.policySource) void this.restartWithFreshCredentials(peer, "cooldown");
      else this.restartIceCoordinated(peer, "cooldown");
    }
    this.armRecovery(peer, "ice-" + peer.pc.iceConnectionState);
  }

  /**
   * Both sides run the same tier clock, so an unconditional restartIce() on
   * each side produced two crossing ICE-restart offers (glare) at every tier
   * step. `none` is used when a remote restart offer already regathers us.
   */
  private activateTier(peer: ManagedPeer, tier: 1 | 2, restart: "coordinated" | "none" = "coordinated"): Promise<void> | void {
    if (tier <= peer.iceTier || peer.pc.connectionState === "closed") return;
    this.clearFallback(peer);
    peer.iceTier = tier;
    peer.lastIceRestartAt = Date.now();
    if (!this.policySource) {
      this.applyTier(peer, tier, restart, this.icePolicy);
      return;
    }
    // TURN credentials are fetched right before the relay tier allocates, so a
    // peer that arrives long after the session was admitted never presents an
    // expired TURN REST username.
    return this.policySource.refresh("tier-" + tier).then((fresh) => {
      if (peer.pc.connectionState === "closed" || peer.iceTier !== tier) return;
      if (!fresh) {
        this.logMediaEvent(peer, "ice-tier-credentials-unavailable", { tier });
        this.callbacks.state(peer);
        this.scheduleFallback(peer);
        this.armRecovery(peer, "credentials-unavailable");
        return;
      }
      this.applyTier(peer, tier, restart, fresh);
    });
  }

  private applyTier(peer: ManagedPeer, tier: 1 | 2, restart: "coordinated" | "none", policy: IceTierPolicy): void {
    peer.pc.setConfiguration({ iceServers: [...cumulativeIceServers(policy, tier)] });
    this.logMediaEvent(peer, "ice-tier-activated", { tier, restart });
    if (restart === "coordinated") this.restartIceCoordinated(peer, "tier-" + tier);
    this.callbacks.state(peer);
    this.scheduleFallback(peer);
    if (!this.nextFallback(peer)) this.armRecovery(peer, "last-tier");
  }

  /** Re-applies the current tier with freshly fetched credentials when they can be had. */
  private async applyFreshTier(peer: ManagedPeer, tier: 0 | 1 | 2, reason: string): Promise<void> {
    const fresh = await this.freshTierServers(tier, reason);
    if (fresh && peer.pc.connectionState !== "closed" && peer.iceTier === tier) {
      peer.pc.setConfiguration({ iceServers: [...fresh] });
    }
  }

  private async freshTierServers(tier: 0 | 1 | 2, reason: string): Promise<readonly RTCIceServer[] | null> {
    if (!this.policySource) return cumulativeIceServers(this.icePolicy, tier);
    const fresh = await this.policySource.refresh(reason);
    if (fresh) return cumulativeIceServers(fresh, tier);
    // Direct STUN carries no credential; only relay tiers depend on a fresh one.
    return tier === 0 ? cumulativeIceServers(this.icePolicy, 0) : null;
  }

  private async restartWithFreshCredentials(peer: ManagedPeer, reason: string): Promise<boolean> {
    const tier = peer.iceTier;
    const servers = await this.freshTierServers(tier, reason);
    if (peer.pc.connectionState === "closed" || peer.iceTier !== tier) return false;
    if (!servers) {
      this.logMediaEvent(peer, "ice-restart-credentials-unavailable", { reason, tier });
      return false;
    }
    peer.pc.setConfiguration({ iceServers: [...servers] });
    peer.lastIceRestartAt = Date.now();
    this.restartIceCoordinated(peer, reason);
    return true;
  }

  private isConnected(peer: ManagedPeer): boolean {
    return peer.pc.connectionState === "connected"
      || peer.pc.iceConnectionState === "connected" || peer.pc.iceConnectionState === "completed";
  }

  /** Arms one bounded recovery attempt; a pending one is kept, never stacked. */
  private armRecovery(peer: ManagedPeer, reason: string): void {
    const control = this.controlFor(peer);
    if (control.recoveryTimer || peer.pc.connectionState === "closed" || this.isConnected(peer)) return;
    const delayMs = Math.min(ICE_RECOVERY_BASE_MS * 2 ** Math.min(control.recoveryAttempt, 8), ICE_RECOVERY_MAX_MS);
    control.recoveryTimer = setTimeout(() => {
      control.recoveryTimer = null;
      void this.recover(peer, reason);
    }, delayMs);
    this.logMediaEvent(peer, "ice-recovery-scheduled", { reason, attempt: control.recoveryAttempt + 1, delayMs });
  }

  private async recover(peer: ManagedPeer, reason: string): Promise<void> {
    if (peer.pc.connectionState === "closed" || this.peers.get(peer.id) !== peer) return;
    const control = this.controlFor(peer);
    if (this.isConnected(peer)) {
      control.recoveryAttempt = 0;
      return;
    }
    if (this.nextFallback(peer)) return; // The tier clock still owns this peer.
    control.recoveryAttempt += 1;
    // restartIce() marks negotiation as needed, so a failed or never-started
    // negotiation is re-offered through the regular perfect-negotiation path.
    const restarted = await this.restartWithFreshCredentials(peer, "recovery:" + reason);
    this.logMediaEvent(peer, "ice-recovery-attempt", {
      reason,
      attempt: control.recoveryAttempt,
      restarted,
      diagnostics: this.hypothesis(peer),
    });
    this.armRecovery(peer, reason);
  }

  private clearRecovery(peer: ManagedPeer, connected = false): void {
    const control = this.negotiationControl.get(peer);
    if (!control) return;
    if (control.recoveryTimer) clearTimeout(control.recoveryTimer);
    control.recoveryTimer = null;
    if (connected && control.recoveryAttempt > 0) {
      this.logMediaEvent(peer, "ice-recovered", { attempts: control.recoveryAttempt });
      control.recoveryAttempt = 0;
    }
  }

  /** The polite side restarts at once; the impolite side only if no remote restart arrives first. */
  private restartIceCoordinated(peer: ManagedPeer, reason: string): void {
    if (peer.polite) {
      peer.pc.restartIce();
      return;
    }
    this.clearDeferredRestart(peer);
    const control = this.controlFor(peer);
    const requestedAt = Date.now();
    control.deferredRestartTimer = setTimeout(() => {
      control.deferredRestartTimer = null;
      if (peer.pc.connectionState === "closed" || peer.pc.connectionState === "connected") return;
      if (control.remoteIceRestartAt >= requestedAt) return;
      this.logMediaEvent(peer, "deferred-ice-restart", { reason, graceMs: ICE_RESTART_GRACE_MS });
      peer.pc.restartIce();
    }, ICE_RESTART_GRACE_MS);
  }

  private clearDeferredRestart(peer: ManagedPeer): void {
    const control = this.negotiationControl.get(peer);
    if (control?.deferredRestartTimer) clearTimeout(control.deferredRestartTimer);
    if (control) control.deferredRestartTimer = null;
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
      staleAnswersIgnored: 0,
      localOffersRolledBack: 0,
      offersUnanswered: 0,
      localDescriptionSet: 0,
      remoteDescriptionSet: 0,
      descriptionErrors: 0,
      lastError: "",
      remoteCandidateErrors: 0,
      candidateErrorsByUrl: {},
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
    diagnostics.lastError = phase + ":" + described.name + ":" + described.message;
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
    this.logMediaEvent(peer, "negotiation-failed", {
      phase,
      error: described,
      descriptionErrors: diagnostics.descriptionErrors,
      transceivers: this.transceiverSummary(peer),
    });
    this.callbacks.negotiationError(peer, error);
    this.armRecovery(peer, "negotiation-failed:" + phase);
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
      staleAnswersIgnored: diagnostics.staleAnswersIgnored,
      localOffersRolledBack: diagnostics.localOffersRolledBack,
      offersUnanswered: diagnostics.offersUnanswered,
      localDescriptionSet: diagnostics.localDescriptionSet,
      remoteDescriptionSet: diagnostics.remoteDescriptionSet,
      descriptionErrors: diagnostics.descriptionErrors,
      lastError: diagnostics.lastError,
      localCandidates: diagnostics.local,
      remoteCandidates: diagnostics.remote,
      candidateErrors: diagnostics.candidateErrors,
      candidateErrorsByUrl: diagnostics.candidateErrorsByUrl,
      remoteCandidateErrors: diagnostics.remoteCandidateErrors,
      iceServers: this.configuredIceServerUrls(peer),
      ...this.appliedIceConfiguration(peer),
      ...this.descriptionTypes(peer),
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

  /**
   * [mediadbg] Diagnostics only: what the RTCPeerConnection really applied
   * (not what the policy intended), description generations, transceivers and
   * the selected candidate pair. Urls and candidate types only; addresses,
   * usernames, credentials and SDP never reach the log.
   */
  private appliedIceConfiguration(peer: ManagedPeer): Record<string, unknown> {
    const configuration = typeof peer.pc.getConfiguration === "function" ? peer.pc.getConfiguration() : null;
    if (!configuration) return { appliedIceServers: null, iceTransportPolicy: null };
    return {
      appliedIceServers: [...iceServerUrls(configuration.iceServers ?? [])],
      iceTransportPolicy: configuration.iceTransportPolicy ?? "all",
      bundlePolicy: configuration.bundlePolicy ?? "balanced",
    };
  }

  private descriptionTypes(peer: ManagedPeer): Record<string, unknown> {
    const pc = peer.pc;
    return {
      currentLocalDescription: pc.currentLocalDescription?.type ?? null,
      currentRemoteDescription: pc.currentRemoteDescription?.type ?? null,
      pendingLocalDescription: pc.pendingLocalDescription?.type ?? null,
      pendingRemoteDescription: pc.pendingRemoteDescription?.type ?? null,
    };
  }

  private transceiverSummary(peer: ManagedPeer): readonly Record<string, unknown>[] {
    const transceivers = typeof peer.pc.getTransceivers === "function" ? peer.pc.getTransceivers() : [];
    return transceivers.map((transceiver) => ({
      mid: transceiver.mid,
      kind: transceiver.receiver.track?.kind ?? null,
      direction: transceiver.direction,
      currentDirection: transceiver.currentDirection,
      sending: transceiver.sender.track !== null,
    }));
  }

  private logMediaEvent(peer: ManagedPeer, event: string, detail: Record<string, unknown> = {}): void {
    console.warn("[mediadbg] " + JSON.stringify({
      at: new Date().toISOString(),
      event,
      peer: peer.id,
      name: peer.name,
      polite: peer.polite,
      ...this.peerStates(peer),
      ...this.descriptionTypes(peer),
      ...this.appliedIceConfiguration(peer),
      ...detail,
    }));
  }

  /**
   * Explains a missing candidate type once gathering completed. `srflx:0` with
   * STUN errors means the STUN server was unreachable; without errors, the
   * reflexive address equalled a host address (pruned as redundant) or UDP
   * to STUN is silently filtered.
   */
  private logGatheringSummary(peer: ManagedPeer): void {
    const diagnostics = this.diagnosticsFor(peer);
    const applied = this.appliedIceConfiguration(peer)["appliedIceServers"] as string[] | null
      ?? [...this.configuredIceServerUrls(peer)];
    const stunUrls = applied.filter((url) => /^stuns?:/i.test(url));
    const turnUrls = applied.filter((url) => /^turns?:/i.test(url));
    const errorUrls = Object.keys(diagnostics.candidateErrorsByUrl);
    const hints: string[] = [];
    if (diagnostics.local.srflx === 0) {
      if (stunUrls.length === 0 && turnUrls.length === 0) hints.push("no-srflx:no-stun-configured");
      else if (errorUrls.some((key) => /^stuns?:/i.test(key))) hints.push("no-srflx:stun-errors");
      else hints.push("no-srflx:no-stun-error(host-is-public-or-stun-udp-filtered)");
    }
    if (diagnostics.local.relay === 0 && peer.iceTier > 0) {
      hints.push(turnUrls.length === 0
        ? "no-relay:no-turn-applied"
        : errorUrls.some((key) => /^turns?:/i.test(key)) ? "no-relay:turn-errors" : "no-relay:no-turn-error");
    }
    this.logMediaEvent(peer, "ice-gathering-complete", {
      localCandidates: diagnostics.local,
      remoteCandidates: diagnostics.remote,
      stunUrls,
      turnUrls,
      candidateErrorsByUrl: diagnostics.candidateErrorsByUrl,
      hints,
    });
  }

  private async logSelectedCandidatePair(peer: ManagedPeer, reason: string): Promise<void> {
    if (typeof peer.pc.getStats !== "function") return;
    try {
      const report = await peer.pc.getStats();
      const values: Record<string, unknown>[] = [];
      report.forEach((value) => values.push(value as Record<string, unknown>));
      const byId = new Map(values.map((stat) => [String(stat["id"]), stat]));
      const pairs = values.filter((stat) => stat["type"] === "candidate-pair");
      const transport = values.find((stat) => stat["type"] === "transport" && stat["selectedCandidatePairId"]);
      const selected = (transport ? byId.get(String(transport["selectedCandidatePairId"])) : undefined)
        ?? pairs.find((pair) => pair["selected"] === true)
        ?? pairs.find((pair) => pair["nominated"] === true && pair["state"] === "succeeded");
      const candidate = (id: unknown) => {
        const stat = id ? byId.get(String(id)) : undefined;
        return stat ? {
          candidateType: stat["candidateType"] ?? null,
          protocol: stat["protocol"] ?? null,
          relayProtocol: stat["relayProtocol"] ?? null,
          url: stat["url"] ?? null,
          networkType: stat["networkType"] ?? null,
        } : null;
      };
      const pairStates: Record<string, number> = {};
      const pairTypes: Record<string, number> = {};
      for (const pair of pairs) {
        const state = String(pair["state"] ?? "unknown");
        pairStates[state] = (pairStates[state] ?? 0) + 1;
        const local = byId.get(String(pair["localCandidateId"]))?.["candidateType"] ?? "?";
        const remote = byId.get(String(pair["remoteCandidateId"]))?.["candidateType"] ?? "?";
        const key = local + "->" + remote + ":" + state;
        pairTypes[key] = (pairTypes[key] ?? 0) + 1;
      }
      this.logMediaEvent(peer, "selected-candidate-pair", {
        reason,
        selectedPair: selected ? {
          state: selected["state"] ?? null,
          nominated: selected["nominated"] ?? null,
          local: candidate(selected["localCandidateId"]),
          remote: candidate(selected["remoteCandidateId"]),
          currentRoundTripTime: selected["currentRoundTripTime"] ?? null,
          requestsSent: selected["requestsSent"] ?? null,
          responsesReceived: selected["responsesReceived"] ?? null,
          bytesSent: selected["bytesSent"] ?? null,
          bytesReceived: selected["bytesReceived"] ?? null,
        } : null,
        dtlsState: transport?.["dtlsState"] ?? null,
        pairs: pairs.length,
        pairStates,
        pairTypes,
      });
    } catch (error) {
      this.logMediaEvent(peer, "selected-candidate-pair-unavailable", { reason, error: describeNegotiationError(error) });
    }
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
