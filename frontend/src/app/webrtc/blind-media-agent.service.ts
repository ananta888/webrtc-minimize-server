import { Injectable, computed, signal } from "@angular/core";

import { cumulativeIceServers, IceTierPolicy } from "./ice-policy";
import {
  MediaAgentRouteState,
  MediaAgentLayer,
  MediaAgentSubscriptionState,
  MediaAgentTakeoverRequest,
  MediaAgentTrackState,
  validateMediaAgentRouteState,
  validateMediaAgentSignal,
  validateMediaAgentTakeoverRequest,
  validateMediaAgentTrackState,
} from "./media-agent-contract";
import { ServerMessage, SignalingService } from "./signaling.service";
import { ManagedPeer } from "./peer-connection-manager";
import {
  MediaAgentRemoteTrackBinding,
  parseMediaAgentRemoteTrackBindings,
} from "./media-agent-sdp";

export interface AvailableMediaAgent {
  readonly id: string;
  readonly online: boolean;
}

export interface AgentPublicationInput {
  readonly agentId: string;
  readonly publicationId: string;
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly source: MediaAgentTrackState["source"];
  readonly contextId: string;
  readonly keyId: string;
  readonly baseKey: Uint8Array;
}

export interface AgentTrackInput {
  readonly agentId: string;
  readonly publisherPeerId: string;
  readonly publicationId: string;
  readonly source: MediaAgentTrackState["source"] | "";
  readonly track: MediaStreamTrack;
  readonly receiver: RTCRtpReceiver;
}

export interface MediaAgentAnalysisSnapshot {
  readonly agents: readonly Readonly<{
    id: string;
    ownerPeerId: string;
    role: "primary" | "standby";
    connected: boolean;
    readyPeerIds: readonly string[];
  }>[];
  readonly publisherAssignments: readonly Readonly<{ peerId: string; agentId: string }>[];
  readonly subscriberAssignments: readonly Readonly<{ peerId: string; agentId: string }>[];
  readonly federationLinks: readonly Readonly<{
    leftAgentId: string;
    rightAgentId: string;
    ready: boolean;
  }>[];
}

interface MediaAgentCallbacks {
  readonly attachSender: (sender: RTCRtpSender, contextId: string, keyId: string, baseKey: Uint8Array) => boolean;
  readonly acceptTrack: (input: AgentTrackInput) => boolean;
  readonly trackState: (state: MediaAgentTrackState) => void;
  readonly routeChanged: () => void;
  readonly connectionChanged: () => void;
}

interface AgentConnection extends ManagedPeer {
  readonly agentId: string;
  readonly pendingCandidates: Array<RTCIceCandidateInit | null>;
  remoteTrackBindings: ReadonlyMap<string, MediaAgentRemoteTrackBinding>;
  connected: boolean;
}

interface PendingAgentTrack {
  readonly input: AgentTrackInput;
  readonly timer: ReturnType<typeof setTimeout>;
}

const EMPTY_CALLBACKS: MediaAgentCallbacks = {
  attachSender: () => false,
  acceptTrack: () => false,
  trackState: () => undefined,
  routeChanged: () => undefined,
  connectionChanged: () => undefined,
};

const CAMERA_SIMULCAST_ENCODINGS: readonly RTCRtpEncodingParameters[] = Object.freeze([
  Object.freeze({ rid: "q", active: true, scaleResolutionDownBy: 4, maxBitrate: 120_000, maxFramerate: 6 }),
  Object.freeze({ rid: "h", active: true, scaleResolutionDownBy: 2, maxBitrate: 420_000, maxFramerate: 15 }),
  Object.freeze({ rid: "f", active: true, scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 24 }),
]);
const SINGLE_VIDEO_ENCODING: RTCRtpEncodingParameters = Object.freeze({ rid: "s", active: true });
const MAX_SELECTED_MEDIA_AGENTS = 3;
const MAX_PENDING_AGENT_TRACKS = 64;
const PENDING_AGENT_TRACK_TTL_MS = 5_000;

@Injectable({ providedIn: "root" })
export class BlindMediaAgentService {
  readonly availableAgents = signal<readonly AvailableMediaAgent[]>([]);
  readonly maximumSelectedAgents = MAX_SELECTED_MEDIA_AGENTS;
  readonly selectedAgentIds = signal<readonly string[]>([]);
  readonly selectedAgentsOnline = computed(() => {
    const selected = this.selectedAgentIds();
    const online = new Set(this.availableAgents().filter((agent) => agent.online).map((agent) => agent.id));
    return selected.length > 0 && selected.every((agentId) => online.has(agentId));
  });
  readonly selectionLimitReached = computed(() => (
    this.selectedAgentIds().length >= MAX_SELECTED_MEDIA_AGENTS
  ));
  readonly consentedAgentIds = signal<readonly string[]>([]);
  readonly consentEnabled = computed(() => this.consentedAgentIds().length > 0);
  readonly automaticTakeover = signal(false);
  readonly primaryAgentId = signal("");
  readonly standbyAgentIds = signal<readonly string[]>([]);
  readonly forwarderAgentIds = signal<readonly string[]>([]);
  readonly routeEpoch = signal(0);
  readonly status = signal<"unavailable" | "idle" | "connecting" | "connected" | "error">("unavailable");
  readonly simulcastCapability = signal<"probing" | "available" | "fallback">("probing");
  readonly takeoverRequest = signal<MediaAgentTakeoverRequest | null>(null);
  private readonly connections = new Map<string, AgentConnection>();
  private readonly descriptors = new Map<string, MediaAgentTrackState>();
  private readonly availableLayers = new Map<string, Set<MediaAgentLayer>>();
  private readonly subscriptionSignatures = new Map<string, string>();
  private readonly subscriptionStates = new Map<string, MediaAgentSubscriptionState>();
  private readonly subscriptionTracks = new Map<string, MediaStreamTrack>();
  private readonly pendingTracks = new Map<string, PendingAgentTrack>();
  private ownPeerId = "";
  private roomId = "";
  private membershipEpoch = 0;
  private lastRouteEpoch = 0;
  private icePolicy: IceTierPolicy | null = null;
  private route: MediaAgentRouteState | null = null;
  private callbacks: MediaAgentCallbacks = EMPTY_CALLBACKS;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private takeoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly signaling: SignalingService) {}

  initialize(input: Readonly<{
    ownPeerId: string;
    roomId: string;
    membershipEpoch: number;
    icePolicy: IceTierPolicy;
    availableAgents: readonly AvailableMediaAgent[];
    callbacks: MediaAgentCallbacks;
  }>): void {
    this.close();
    this.ownPeerId = input.ownPeerId;
    this.roomId = input.roomId;
    this.membershipEpoch = input.membershipEpoch;
    this.icePolicy = input.icePolicy;
    this.callbacks = input.callbacks;
    this.setAvailability(input.availableAgents);
    const agents = this.availableAgents();
    this.status.set(agents.length > 0 ? "idle" : "unavailable");
  }

  applyAvailability(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value["version"] !== 1 || value["type"] !== "media-agent-availability"
      || !Array.isArray(value["agents"])) return false;
    return this.setAvailability(value["agents"]);
  }

  updateMembershipEpoch(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) return;
    this.membershipEpoch = value;
  }

  setConsent(enabled: boolean, automaticTakeover = this.automaticTakeover()): void {
    if (!this.ownPeerId || (!enabled && !this.consentEnabled())) return;
    const agentIds = enabled ? this.selectedAgentIds() : [];
    if (enabled && !this.selectedAgentsOnline()) return;
    this.signaling.send({
      version: 1,
      type: "media-agent-consent-set",
      agentIds: [...agentIds],
      automaticTakeover,
    });
    this.consentedAgentIds.set(Object.freeze([...agentIds]));
    this.automaticTakeover.set(automaticTakeover);
    if (!enabled) this.retainOnlineSelection();
  }

  setAutomaticTakeover(enabled: boolean): void {
    this.automaticTakeover.set(enabled);
    if (this.consentEnabled()) this.setConsent(true, enabled);
  }

  setAgentSelected(agentId: string, enabled: boolean): void {
    if (this.consentEnabled()) return;
    const agent = this.availableAgents().find((candidate) => candidate.id === agentId);
    if (!agent || (enabled && !agent.online)) return;
    const selected = new Set(this.selectedAgentIds());
    if (enabled) {
      if (selected.size >= MAX_SELECTED_MEDIA_AGENTS && !selected.has(agentId)) return;
      selected.add(agentId);
    } else {
      selected.delete(agentId);
    }
    this.selectedAgentIds.set(Object.freeze([...selected].sort()));
  }

  isAgentSelected(agentId: string): boolean {
    return this.selectedAgentIds().includes(agentId);
  }

  respondToTakeover(accepted: boolean): void {
    const request = this.takeoverRequest();
    if (!request) return;
    this.signaling.send({ type: "media-agent-takeover-response", requestId: request.requestId, accepted });
    if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
    this.takeoverTimer = null;
    this.takeoverRequest.set(null);
  }

  applyTakeoverRequest(raw: unknown): void {
    const request = validateMediaAgentTakeoverRequest(raw);
    if (request && this.availableAgents().some((agent) => agent.id === request.agentId && agent.online)) {
      if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
      this.takeoverRequest.set(request);
      this.takeoverTimer = setTimeout(() => {
        if (this.takeoverRequest()?.requestId === request.requestId) this.takeoverRequest.set(null);
        this.takeoverTimer = null;
      }, Math.max(0, request.expiresAt - Date.now()));
    }
  }

  applyRoute(raw: unknown, memberPeerIds: ReadonlySet<string>): boolean {
    const state = validateMediaAgentRouteState(
      raw,
      memberPeerIds,
      this.membershipEpoch,
      this.lastRouteEpoch,
    );
    if (!state) return false;
    const routeChanged = state.routeEpoch !== this.lastRouteEpoch
      || state.primary?.id !== this.route?.primary?.id;
    if (routeChanged) {
      for (const agentId of [...this.connections.keys()]) this.closeConnection(agentId, false);
      this.descriptors.clear();
      this.availableLayers.clear();
      this.subscriptionSignatures.clear();
      this.subscriptionStates.clear();
      this.subscriptionTracks.clear();
      this.clearPendingTracks();
    }
    this.route = state;
    this.lastRouteEpoch = state.routeEpoch;
    this.primaryAgentId.set(state.primary?.id || "");
    this.standbyAgentIds.set(state.standbys.map(({ id }) => id));
    this.forwarderAgentIds.set(state.forwarderIds);
    this.routeEpoch.set(state.routeEpoch);
    this.scheduleExpiry(state);
    this.syncConnections(state);
    if (routeChanged) this.callbacks.routeChanged();
    this.updateStatus();
    return true;
  }

  async acceptSignal(message: ServerMessage): Promise<void> {
    const signal = validateMediaAgentSignal(message);
    if (!signal || signal.roomId !== this.roomId || signal.routeEpoch !== this.routeEpoch()) return;
    const connection = this.connections.get(signal.agentId);
    if (!connection) return;
    try {
      const description = "description" in signal ? signal.description : undefined;
      if (description) {
        if (!new Set(["offer", "answer"]).has(description.type) || typeof description.sdp !== "string") return;
        const remoteTrackBindings = description.type === "offer"
          ? parseMediaAgentRemoteTrackBindings(description.sdp)
          : null;
        if (description.type === "offer" && !remoteTrackBindings) throw new Error("invalid_media_agent_sdp_binding");
        const collision = description.type === "offer"
          && (connection.makingOffer || connection.pc.signalingState !== "stable");
        if (collision) await connection.pc.setLocalDescription({ type: "rollback" });
        connection.settingRemoteAnswerPending = description.type === "answer";
        const previousRemoteTrackBindings = connection.remoteTrackBindings;
        if (remoteTrackBindings) connection.remoteTrackBindings = remoteTrackBindings;
        try {
          // Firefox can dispatch `track` synchronously while the remote offer is
          // being installed. Make the already validated MID authority visible
          // before that event, then restore the previous binding on rejection.
          await connection.pc.setRemoteDescription(description);
        } catch (error) {
          if (remoteTrackBindings) connection.remoteTrackBindings = previousRemoteTrackBindings;
          throw error;
        }
        connection.settingRemoteAnswerPending = false;
        for (const candidate of connection.pendingCandidates.splice(0)) {
          await connection.pc.addIceCandidate(candidate);
        }
        if (description.type === "offer") {
          await connection.pc.setLocalDescription();
          this.sendSignal(signal.agentId, { description: connection.pc.localDescription });
        }
        return;
      }
      const candidate = "candidate" in signal ? signal.candidate : null;
      if (!connection.pc.remoteDescription) {
        if (connection.pendingCandidates.length >= 256) throw new Error("media_agent_candidate_queue_full");
        connection.pendingCandidates.push(candidate);
        return;
      }
      await connection.pc.addIceCandidate(candidate);
    } catch {
      connection.settingRemoteAnswerPending = false;
      this.status.set("error");
    }
  }

  applyTrackState(raw: unknown): void {
    const state = validateMediaAgentTrackState(raw);
    if (!state || state.routeEpoch !== this.routeEpoch()
      || state.agentId !== this.assignedAgentId(state.peerId)) return;
    const key = this.publicationKey(state.peerId, state.publicationId);
    let layers = this.availableLayers.get(key);
    if (!layers) {
      layers = new Set();
      this.availableLayers.set(key, layers);
    }
    if (state.active) {
      layers.add(state.layer);
      this.descriptors.set(key, state);
    } else {
      layers.delete(state.layer);
      if (layers.size === 0) {
        this.availableLayers.delete(key);
        this.descriptors.delete(key);
      }
    }
    if (state.active || layers.size === 0) this.callbacks.trackState(state);
    if (state.active) this.acceptPendingTrack(state.peerId, state.publicationId);
    else if (layers.size === 0) this.dropPendingTracks(state.peerId, state.publicationId);
  }

  activatePublication(input: AgentPublicationInput): boolean {
    if (input.agentId !== this.assignedAgentId(this.ownPeerId)) return false;
    const connection = this.connections.get(input.agentId);
    if (!connection || connection.senders.has(input.publicationId) || input.track.readyState !== "live") return false;
    try {
      let sender: RTCRtpSender;
      if (input.source === "camera" && input.track.kind === "video") {
        try {
          sender = connection.pc.addTransceiver(input.track, {
            direction: "sendonly",
            streams: [input.stream],
            sendEncodings: CAMERA_SIMULCAST_ENCODINGS.map((encoding) => ({ ...encoding })),
          }).sender;
          this.simulcastCapability.set("available");
        } catch {
          try {
            sender = connection.pc.addTransceiver(input.track, {
              direction: "sendonly",
              streams: [input.stream],
              sendEncodings: [{ ...SINGLE_VIDEO_ENCODING }],
            }).sender;
          } catch {
            sender = connection.pc.addTrack(input.track, input.stream);
          }
          this.simulcastCapability.set("fallback");
        }
      } else if (input.track.kind === "video") {
        try {
          sender = connection.pc.addTransceiver(input.track, {
            direction: "sendonly",
            streams: [input.stream],
            sendEncodings: [{ ...SINGLE_VIDEO_ENCODING }],
          }).sender;
        } catch {
          sender = connection.pc.addTrack(input.track, input.stream);
        }
      } else {
        sender = connection.pc.addTrack(input.track, input.stream);
      }
      if (!this.callbacks.attachSender(sender, input.contextId, input.keyId, input.baseKey)) {
        connection.pc.removeTrack(sender);
        return false;
      }
      connection.senders.set(input.publicationId, sender);
      return true;
    } catch { return false; }
  }

  deactivatePublication(publicationId: string): void {
    for (const connection of this.connections.values()) {
      const sender = connection.senders.get(publicationId);
      if (!sender) continue;
      try { connection.pc.removeTrack(sender); } catch { /* already closed */ }
      connection.senders.delete(publicationId);
    }
  }

  sender(publicationId: string): RTCRtpSender | null {
    return this.connections.get(this.assignedAgentId(this.ownPeerId))?.senders.get(publicationId) || null;
  }

  qualityTarget(publicationId: string): Readonly<{ peer: ManagedPeer; sender: RTCRtpSender }> | null {
    const connection = this.connections.get(this.assignedAgentId(this.ownPeerId));
    const sender = connection?.senders.get(publicationId);
    return connection && sender ? { peer: connection, sender } : null;
  }

  analysisTargets(): readonly Readonly<{ agentId: string; peer: ManagedPeer }>[] {
    return Object.freeze([...this.connections.values()]
      .map((peer) => Object.freeze({ agentId: peer.agentId, peer }))
      .sort((left, right) => left.agentId.localeCompare(right.agentId)));
  }

  analysisSnapshot(): MediaAgentAnalysisSnapshot {
    const route = this.route;
    if (!route) return Object.freeze({
      agents: Object.freeze([]),
      publisherAssignments: Object.freeze([]),
      subscriberAssignments: Object.freeze([]),
      federationLinks: Object.freeze([]),
    });
    const candidates = [route.primary, ...route.standbys].filter(Boolean) as NonNullable<typeof route.primary>[];
    return Object.freeze({
      agents: Object.freeze(candidates.map((agent) => {
        const readyPeerIds = route.readiness.find(({ agentId }) => agentId === agent.id)?.readyPeerIds || [];
        return Object.freeze({
          id: agent.id,
          ownerPeerId: agent.ownerPeerId,
          role: route.primary?.id === agent.id ? "primary" as const : "standby" as const,
          connected: this.connections.get(agent.id)?.connected === true,
          readyPeerIds: Object.freeze([...readyPeerIds]),
        });
      })),
      publisherAssignments: Object.freeze([...route.publisherAssignments]),
      subscriberAssignments: Object.freeze([...route.subscriberAssignments]),
      federationLinks: Object.freeze(route.federationLinks.map((link) => Object.freeze({
        leftAgentId: link.leftAgentId,
        rightAgentId: link.rightAgentId,
        ready: link.readyAgentIds.length === 2,
      }))),
    });
  }

  assignedAgentId(publisherPeerId: string): string {
    return this.route?.publisherAssignments.find((entry) => entry.peerId === publisherPeerId)?.agentId || "";
  }

  assignedSubscriberAgentId(subscriberPeerId: string): string {
    return this.route?.subscriberAssignments.find((entry) => entry.peerId === subscriberPeerId)?.agentId || "";
  }

  setSubscriptionIntent(input: Readonly<{
    publisherPeerId: string;
    publicationId: string;
    source: MediaAgentTrackState["source"];
    enabled: boolean;
    preferredLayer: MediaAgentLayer;
    maximumLayer: MediaAgentLayer;
  }>): boolean {
    const agentId = this.assignedSubscriberAgentId(this.ownPeerId);
    const routeEpoch = this.routeEpoch();
    if (!agentId || routeEpoch < 1 || input.publisherPeerId === this.ownPeerId) return false;
    const key = `${input.publisherPeerId}\0${input.publicationId}`;
    const signature = [
      agentId, routeEpoch, input.enabled, input.preferredLayer, input.maximumLayer,
    ].join(":");
    if (this.subscriptionSignatures.get(key) === signature) return true;
    try {
      this.signaling.send({
        version: 1,
        type: "media-agent-subscription-intent",
        agentId,
        roomId: this.roomId,
        routeEpoch,
        publisherPeerId: input.publisherPeerId,
        publicationId: input.publicationId,
        enabled: input.enabled,
        preferredLayer: input.preferredLayer,
        maximumLayer: input.maximumLayer,
      });
      this.subscriptionSignatures.set(key, signature);
      this.subscriptionStates.delete(key);
      return true;
    } catch { return false; }
  }

  clearSubscriptionIntent(publisherPeerId: string, publicationId: string): void {
    const key = `${publisherPeerId}\0${publicationId}`;
    this.subscriptionSignatures.delete(key);
    this.subscriptionStates.delete(key);
    this.subscriptionTracks.delete(key);
  }

  applySubscriptionState(publisherPeerId: string, state: MediaAgentSubscriptionState): boolean {
    const key = this.publicationKey(publisherPeerId, state.publicationId);
    const previous = this.subscriptionStates.get(key);
    if (state.subscriberPeerId !== this.ownPeerId
      || state.agentId !== this.assignedSubscriberAgentId(this.ownPeerId)
      || state.routeEpoch !== this.routeEpoch()
      || !this.subscriptionSignatures.has(key)
      || (previous && state.revision < previous.revision)) return false;
    this.subscriptionStates.set(key, state);
    if (state.ready) this.acknowledgeSubscriptionTrack(key, publisherPeerId);
    return true;
  }

  routeReady(agentId: string, memberPeerIds: ReadonlySet<string>): boolean {
    const connection = this.connections.get(agentId);
    const ready = new Set(this.route?.readiness.find((entry) => entry.agentId === agentId)?.readyPeerIds || []);
    return Boolean(connection?.connected) && [...memberPeerIds].every((peerId) => ready.has(peerId));
  }

  close(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
    this.expiryTimer = null;
    this.takeoverTimer = null;
    for (const agentId of [...this.connections.keys()]) this.closeConnection(agentId, false);
    this.connections.clear();
    this.descriptors.clear();
    this.availableLayers.clear();
    this.subscriptionSignatures.clear();
    this.subscriptionStates.clear();
    this.subscriptionTracks.clear();
    this.clearPendingTracks();
    this.availableAgents.set([]);
    this.selectedAgentIds.set([]);
    this.consentedAgentIds.set([]);
    this.automaticTakeover.set(false);
    this.primaryAgentId.set("");
    this.standbyAgentIds.set([]);
    this.forwarderAgentIds.set([]);
    this.routeEpoch.set(0);
    this.takeoverRequest.set(null);
    this.status.set("unavailable");
    this.simulcastCapability.set("probing");
    this.ownPeerId = "";
    this.roomId = "";
    this.membershipEpoch = 0;
    this.lastRouteEpoch = 0;
    this.icePolicy = null;
    this.route = null;
    this.callbacks = EMPTY_CALLBACKS;
  }

  private syncConnections(state: MediaAgentRouteState): void {
    const assigned = new Set([
      this.assignedAgentId(this.ownPeerId),
      this.assignedSubscriberAgentId(this.ownPeerId),
    ].filter(Boolean));
    for (const agentId of [...this.connections.keys()]) {
      if (!assigned.has(agentId)) this.closeConnection(agentId, true);
    }
    for (const agentId of assigned) if (!this.connections.has(agentId)) this.createConnection(agentId);
  }

  private createConnection(agentId: string): void {
    if (!this.icePolicy) return;
    const pc = new RTCPeerConnection({ iceServers: [...cumulativeIceServers(this.icePolicy, 2)] });
    const connection: AgentConnection = {
      id: agentId,
      name: `Media-Agent ${agentId}`,
      agentId,
      pc,
      channels: new Map(),
      senders: new Map(),
      appliedTiers: new Map(),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      polite: true,
      linkClass: "unknown",
      reportedLinkClass: "unknown",
      lastControlSequence: -1,
      healthSamples: 0,
      linkCandidate: "unknown",
      linkCandidateSince: Date.now(),
      iceTier: 2,
      icePath: "unknown",
      iceStartedAt: Date.now(),
      fallbackTimer: null,
      lastIceRestartAt: 0,
      connected: false,
      pendingCandidates: [],
      remoteTrackBindings: new Map(),
    };
    this.connections.set(agentId, connection);
    pc.onicecandidate = ({ candidate }) => this.sendSignal(agentId, { candidate });
    pc.ontrack = ({ track, receiver, streams, transceiver }) => {
      const streamPublisherPeerId = streams[0]?.id || "";
      const mid = transceiver?.mid || pc.getTransceivers()
        .find((candidate) => candidate.receiver === receiver)?.mid || "";
      const binding = mid ? connection.remoteTrackBindings.get(mid) : undefined;
      if (binding && binding.kind !== track.kind) {
        track.enabled = false;
        return;
      }
      const candidatePublisherPeerId = binding?.publisherPeerId || streamPublisherPeerId;
      const candidatePublicationId = binding?.publicationId || track.id;
      const descriptor = this.descriptors.get(
        this.publicationKey(candidatePublisherPeerId, candidatePublicationId),
      );
      const publisherPeerId = descriptor?.peerId || candidatePublisherPeerId;
      const input: AgentTrackInput = {
        agentId,
        publisherPeerId,
        publicationId: descriptor?.publicationId || candidatePublicationId,
        source: descriptor?.source || "",
        track,
        receiver,
      };
      if (!descriptor && this.queuePendingTrack(input)) return;
      this.acceptInboundTrack(input);
    };
    pc.onconnectionstatechange = () => {
      const connected = pc.connectionState === "connected";
      if (connection.connected !== connected) {
        connection.connected = connected;
        try {
          this.signaling.send({
            type: "media-agent-peer-state",
            agentId,
            roomId: this.roomId,
            routeEpoch: this.routeEpoch(),
            connected,
          });
        } catch { /* session is closing */ }
      }
      if (pc.connectionState === "failed") this.status.set("error");
      else this.updateStatus();
      this.callbacks.connectionChanged();
    };
    pc.onnegotiationneeded = () => void this.negotiate(connection);
    pc.createDataChannel("media-agent-control", { ordered: true });
    this.updateStatus();
  }

  private async negotiate(connection: AgentConnection): Promise<void> {
    try {
      connection.makingOffer = true;
      await connection.pc.setLocalDescription();
      this.sendSignal(connection.agentId, { description: connection.pc.localDescription });
    } catch { this.status.set("error"); } finally { connection.makingOffer = false; }
  }

  private sendSignal(agentId: string, payload: object): void {
    try {
      this.signaling.send({
        type: "media-agent-signal",
        agentId,
        roomId: this.roomId,
        routeEpoch: this.routeEpoch(),
        ...payload,
      });
    } catch { /* session is closing */ }
  }

  private closeConnection(agentId: string, announce: boolean): void {
    const connection = this.connections.get(agentId);
    if (!connection) return;
    this.connections.delete(agentId);
    if (announce && connection.connected) {
      try {
        this.signaling.send({
          type: "media-agent-peer-state",
          agentId,
          roomId: this.roomId,
          routeEpoch: this.routeEpoch(),
          connected: false,
        });
      } catch { /* session is closing */ }
    }
    connection.pc.close();
  }

  private sendSubscriptionAck(
    agentId: string,
    publisherPeerId: string,
    publicationId: string,
    revision: number,
    ready: boolean,
  ): void {
    try {
      this.signaling.send({
        version: 1,
        type: "media-agent-subscription-ack",
        agentId,
        roomId: this.roomId,
        routeEpoch: this.routeEpoch(),
        publisherPeerId,
        publicationId,
        revision,
        ready,
      });
    } catch { /* session is closing */ }
  }

  private acknowledgeSubscriptionTrack(key: string, publisherPeerId: string): void {
    const state = this.subscriptionStates.get(key);
    if (!state?.ready || !this.subscriptionTracks.has(key)) return;
    this.sendSubscriptionAck(
      state.agentId, publisherPeerId, state.publicationId, state.revision, true,
    );
  }

  private scheduleExpiry(state: MediaAgentRouteState): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      if (this.route?.leaseExpiresAt !== state.leaseExpiresAt) return;
      for (const agentId of [...this.connections.keys()]) this.closeConnection(agentId, false);
      this.primaryAgentId.set("");
      this.standbyAgentIds.set([]);
      this.forwarderAgentIds.set([]);
      this.route = null;
      this.status.set(this.availableAgents().length ? "idle" : "unavailable");
      this.callbacks.routeChanged();
    }, Math.max(0, state.leaseExpiresAt - Date.now()));
  }

  private updateStatus(): void {
    if (!this.primaryAgentId()) {
      this.status.set(this.availableAgents().length ? "idle" : "unavailable");
      return;
    }
    const assignedAgentIds = new Set([
      this.assignedAgentId(this.ownPeerId),
      this.assignedSubscriberAgentId(this.ownPeerId),
    ].filter(Boolean));
    const assignedConnections = [...assignedAgentIds].map((agentId) => this.connections.get(agentId));
    if (assignedConnections.length > 0 && assignedConnections.every((connection) => connection?.connected)) {
      this.status.set("connected");
    } else if (assignedConnections.some((connection) => connection?.pc.connectionState === "failed")) {
      this.status.set("error");
    } else {
      this.status.set("connecting");
    }
  }

  private setAvailability(raw: readonly unknown[]): boolean {
    if (raw.length > 32) return false;
    const agents: AvailableMediaAgent[] = [];
    for (const candidate of raw) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const value = candidate as Record<string, unknown>;
      if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "id") || !Object.hasOwn(value, "online")
        || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(value["id"] || ""))
        || typeof value["online"] !== "boolean") return false;
      agents.push(Object.freeze({ id: String(value["id"]), online: value["online"] }));
    }
    if (new Set(agents.map(({ id }) => id)).size !== agents.length) return false;
    agents.sort((left, right) => left.id.localeCompare(right.id));
    const selected = this.selectedAgentIds();
    this.availableAgents.set(Object.freeze(agents));
    if (!this.consentEnabled()) this.retainOnlineSelection(selected);
    this.updateStatus();
    return true;
  }

  private retainOnlineSelection(selected = this.selectedAgentIds()): void {
    const onlineAgents = this.availableAgents().filter((agent) => agent.online);
    const onlineIds = new Set(onlineAgents.map((agent) => agent.id));
    const retained = selected.filter((agentId) => onlineIds.has(agentId));
    this.selectedAgentIds.set(Object.freeze(
      retained.length > 0 ? retained : onlineAgents.slice(0, 1).map((agent) => agent.id),
    ));
  }

  private publicationKey(publisherPeerId: string, publicationId: string): string {
    return `${publisherPeerId}\0${publicationId}`;
  }

  private pendingTrackKey(input: Pick<AgentTrackInput, "agentId" | "publisherPeerId" | "publicationId">): string {
    return `${input.agentId}\0${input.publisherPeerId}\0${input.publicationId}`;
  }

  private queuePendingTrack(input: AgentTrackInput): boolean {
    if (!input.publisherPeerId || input.publisherPeerId === this.ownPeerId
      || this.assignedSubscriberAgentId(this.ownPeerId) !== input.agentId
      || !this.route?.publisherAssignments.some(({ peerId }) => peerId === input.publisherPeerId)
      || this.pendingTracks.size >= MAX_PENDING_AGENT_TRACKS) {
      input.track.enabled = false;
      return false;
    }
    const key = this.pendingTrackKey(input);
    const previous = this.pendingTracks.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      previous.input.track.enabled = false;
    }
    input.track.enabled = false;
    const timer = setTimeout(() => {
      const current = this.pendingTracks.get(key);
      if (current?.input.track !== input.track) return;
      this.pendingTracks.delete(key);
      input.track.enabled = false;
    }, PENDING_AGENT_TRACK_TTL_MS);
    this.pendingTracks.set(key, { input, timer });
    return true;
  }

  private acceptPendingTrack(publisherPeerId: string, publicationId: string): void {
    const descriptor = this.descriptors.get(this.publicationKey(publisherPeerId, publicationId));
    if (!descriptor) return;
    for (const [key, pending] of this.pendingTracks) {
      if (pending.input.publisherPeerId !== publisherPeerId || pending.input.publicationId !== publicationId) continue;
      clearTimeout(pending.timer);
      this.pendingTracks.delete(key);
      this.acceptInboundTrack({ ...pending.input, source: descriptor.source });
    }
  }

  private acceptInboundTrack(input: AgentTrackInput): void {
    const accepted = this.callbacks.acceptTrack(input);
    input.track.enabled = accepted;
    if (!accepted || !input.publisherPeerId || input.publisherPeerId === this.ownPeerId) return;
    const subscriptionKey = this.publicationKey(input.publisherPeerId, input.publicationId);
    this.subscriptionTracks.set(subscriptionKey, input.track);
    this.acknowledgeSubscriptionTrack(subscriptionKey, input.publisherPeerId);
    input.track.addEventListener("ended", () => {
      if (this.subscriptionTracks.get(subscriptionKey) !== input.track) return;
      this.subscriptionTracks.delete(subscriptionKey);
      const state = this.subscriptionStates.get(subscriptionKey);
      if (state) this.sendSubscriptionAck(
        input.agentId, input.publisherPeerId, input.publicationId, state.revision, false,
      );
    }, { once: true });
  }

  private dropPendingTracks(publisherPeerId: string, publicationId: string): void {
    for (const [key, pending] of this.pendingTracks) {
      if (pending.input.publisherPeerId !== publisherPeerId || pending.input.publicationId !== publicationId) continue;
      clearTimeout(pending.timer);
      pending.input.track.enabled = false;
      this.pendingTracks.delete(key);
    }
  }

  private clearPendingTracks(): void {
    for (const pending of this.pendingTracks.values()) {
      clearTimeout(pending.timer);
      pending.input.track.enabled = false;
    }
    this.pendingTracks.clear();
  }
}
