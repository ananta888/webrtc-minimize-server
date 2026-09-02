import { Injectable, computed, signal } from "@angular/core";

import { AudioActivityService } from "./audio-activity.service";
import { IcePathClass, IceTierPolicy } from "./ice-policy";
import {
  LinkClass,
  MediaSource,
  OptimizationMode,
  QUALITY_SETTINGS,
  VideoTier,
  selectVideoQuality,
} from "./media-optimization-policy";
import {
  CHAT_BUFFER_LIMIT,
  CONTROL_BUFFER_LIMIT,
  parsePeerChat,
  parsePeerControl,
} from "./peer-control-protocol";
import { ServerMessage, SignalingService } from "./signaling.service";
import {
  BoundedOverlayQueue,
  OpaqueDataOverlay,
  OverlayPacket,
  OverlayTrafficClass,
} from "./opaque-data-overlay";
import { MediaE2eeController } from "./media-e2ee-controller";
import {
  AgentTrackInput,
  AvailableMediaAgent,
  BlindMediaAgentService,
} from "./blind-media-agent.service";
import {
  createMediaAgentKeyAck,
  createMediaAgentKeyMessage,
  decodeMediaAgentBaseKey,
  MediaAgentKeyMessage,
  parseMediaAgentE2eeMessage,
} from "./media-agent-e2ee-protocol";
import {
  MediaAgentLayer,
  MediaAgentTrackState,
  validateMediaAgentSubscriptionState,
} from "./media-agent-contract";
import {
  createMediaKeyAck,
  createMediaKeyMessage,
  decodeMediaBaseKey,
  MediaKeyMessage,
  parseMediaE2eeMessage,
  randomMediaKey,
} from "./media-e2ee-protocol";
import { ManagedPeer, PeerConnectionManager } from "./peer-connection-manager";
import { PeerTopologyController } from "./peer-topology-controller";
import { TrustedRelayController } from "./trusted-relay-controller";
import { PeerQualityController } from "./peer-quality-controller";
import { MediaStrategyService } from "./media-strategy.service";
import {
  ReceiveQualityProfile,
  capVideoQualityForReceiver,
  mediaAgentCameraLayerCeiling,
  receiveVideoEnabled,
} from "./receive-quality-policy";
import { ReceiveQualityPreferenceService } from "./receive-quality-preference.service";

interface PeerState extends ManagedPeer {
  readonly overlayQueue: BoundedOverlayQueue;
}

interface Publication {
  readonly id: string;
  rootPeerId: string;
  rootName: string;
  source: MediaSource;
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly local: boolean;
  readonly inboundPeerId: string;
}

export interface OptimizationRuntimeConfig {
  readonly activeSpeakerLimit: number;
  readonly peerRelayEnabled: boolean;
  readonly peerRelayMinParticipants: number;
  readonly peerRelayMaxChildren: number;
  readonly peerRelayMaxHops: number;
  readonly routeLeaseMs: number;
  readonly dataOverlayEnabled: boolean;
}

interface PendingMediaKey {
  readonly contextId: string;
  readonly targetPeerId: string;
  readonly message: MediaKeyMessage;
  readonly baseKey: Uint8Array;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface AgentMediaKeyState {
  readonly contextId: string;
  readonly agentId: string;
  readonly routeEpoch: number;
  readonly message: MediaAgentKeyMessage;
  readonly baseKey: Uint8Array;
  readonly acknowledgedPeerIds: Set<string>;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}

export interface MediaE2eeRuntimeConfig {
  readonly mode: "disabled" | "preferred" | "required";
  readonly cipherSuite: "AES_128_GCM_SHA256_128";
}

export interface RemoteMediaView {
  readonly key: string;
  readonly peerId: string;
  readonly peerName: string;
  readonly transportPeerId: string;
  readonly source: MediaSource;
  readonly stream: MediaStream;
  readonly kind: "audio" | "video";
}

export interface ChatEntry {
  readonly id: number;
  readonly author: string;
  readonly text: string;
  readonly system: boolean;
}

export interface OverlayDelivery {
  readonly id: number;
  readonly originPeerId: string;
  readonly trafficClass: OverlayTrafficClass;
  readonly data: Uint8Array;
}

export interface PeerChoice {
  readonly id: string;
  readonly name: string;
}

const LINK_ORDER: readonly LinkClass[] = ["unknown", "good", "constrained", "critical"];

function worseLink(left: LinkClass, right: LinkClass): LinkClass {
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  return LINK_ORDER[Math.max(LINK_ORDER.indexOf(left), LINK_ORDER.indexOf(right))];
}

function sourceKind(source: MediaSource): "audio" | "video" {
  return source === "microphone" || source === "screen-audio" ? "audio" : "video";
}

const AGENT_VIDEO_LAYER_RANK: Readonly<Record<"low" | "medium" | "high", number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

function agentLayerForTier(tier: VideoTier): "low" | "medium" | "high" {
  if (tier === "screen" || tier === "focus") return "high";
  if (tier === "balanced") return "medium";
  return "low";
}

@Injectable({ providedIn: "root" })
export class PeerMeshService {
  readonly remoteMedia = signal<readonly RemoteMediaView[]>([]);
  readonly participantCount = signal(0);
  readonly chat = signal<readonly ChatEntry[]>([]);
  readonly overlayDeliveries = signal<readonly OverlayDelivery[]>([]);
  readonly overlayMode = signal<"unavailable" | "direct-encrypted" | "opaque-relay">("unavailable");
  readonly overlayReady = signal(false);
  readonly peerChoices = signal<readonly PeerChoice[]>([]);
  readonly iceState = signal("idle");
  readonly icePath = signal<IcePathClass>("unknown");
  readonly mediaE2eeState = signal<"disabled" | "unsupported" | "pending" | "active">("disabled");
  readonly topologyMode = signal<"adaptive_mesh" | "trusted_peer_relay">("adaptive_mesh");
  readonly topologyEpoch = signal(0);
  readonly membershipEpoch = signal(0);
  readonly routeEpoch = signal(0);
  readonly mediaAgentStatus = this.mediaAgents.status;
  readonly mediaAgentPrimaryId = this.mediaAgents.primaryAgentId;
  readonly mediaAgentRouteEpoch = this.mediaAgents.routeEpoch;
  readonly optimizationMode = this.mediaStrategy.optimizationMode;
  readonly receiveQualityProfile = this.receiveQuality.profile;
  readonly relayConsent = signal(false);
  readonly relayCapability = signal<"idle" | "available" | "unsupported">("idle");
  readonly qualityCapability = signal<"probing" | "available" | "degraded">("probing");
  readonly localQuality = signal<VideoTier | "audio-only" | "idle">("idle");
  readonly linkSummary = signal<LinkClass>("unknown");
  readonly activeSpeakerIds = this.activity.activePeerIds;
  readonly activeSpeakerNames = computed(() => this.focusPeerIds().map((peerId) => this.peerName(peerId)));
  readonly focusRemoteMedia = computed(() => {
    const focus = new Set(this.focusPeerIds());
    return this.remoteMedia().filter((item) => item.kind === "video"
      && (item.source === "screen" || focus.has(item.peerId)));
  });
  readonly mosaicRemoteMedia = computed(() => {
    const focusKeys = new Set(this.focusRemoteMedia().map((item) => item.key));
    return this.remoteMedia().filter((item) => item.kind === "video"
      && item.source === "camera" && !focusKeys.has(item.key));
  });
  readonly remoteAudio = computed(() => this.remoteMedia().filter((item) => item.kind === "audio"));
  private connections: PeerConnectionManager | null = null;
  private readonly participantNames = new Map<string, string>();
  private readonly localStreams = new Map<string, MediaStream>();
  private readonly publications = new Map<string, Publication>();
  private readonly descriptors = new Map<string, Pick<Publication, "rootPeerId" | "rootName" | "source">>();
  private readonly topology = new PeerTopologyController(() => {
    this.topologyMode.set("adaptive_mesh");
    this.applyReceivePlaybackPreference();
    this.reconcileAllPublications();
  });
  private readonly relay = new TrustedRelayController(this.topology);
  private readonly quality = new PeerQualityController();
  private readonly overlay = new OpaqueDataOverlay();
  private overlayPublicKey: JsonWebKey | null = null;
  private overlayInitialization: Promise<void> = Promise.resolve();
  private overlayGeneration = 0;
  private overlaySerial = 0;
  private ownId = "";
  private ownName = "";
  private icePolicy: IceTierPolicy | null = null;
  private mediaE2ee: MediaE2eeRuntimeConfig = {
    mode: "disabled",
    cipherSuite: "AES_128_GCM_SHA256_128",
  };
  private mediaE2eeController: MediaE2eeController | null = null;
  private readonly pendingMediaKeys = new Map<string, PendingMediaKey>();
  private readonly activeSenderMediaContexts = new Set<string>();
  private readonly activeReceiverMediaContexts = new Set<string>();
  private readonly agentMediaKeys = new Map<string, AgentMediaKeyState>();
  private readonly agentSubscriptionReady = new Map<string, Set<string>>();
  private readonly agentSubscriptionRevisions = new Map<string, number>();
  private readonly requestedReceiveProfiles = new Map<string, ReceiveQualityProfile>();
  private readonly sentReceiveProfiles = new Map<string, ReceiveQualityProfile>();
  private membershipStable = false;
  private roomId = "";
  private optimization: OptimizationRuntimeConfig = {
    activeSpeakerLimit: 5,
    peerRelayEnabled: false,
    peerRelayMinParticipants: 6,
    peerRelayMaxChildren: 3,
    peerRelayMaxHops: 3,
    routeLeaseMs: 60_000,
    dataOverlayEnabled: false,
  };
  private chatSerial = 0;
  private controlSequence = 0;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private readonly visibilityHandler = () => this.publishRelayCapability();

  private get peers(): ReadonlyMap<string, PeerState> {
    return (this.connections?.peers || new Map()) as ReadonlyMap<string, PeerState>;
  }

  constructor(
    private readonly signaling: SignalingService,
    private readonly activity: AudioActivityService,
    private readonly mediaStrategy: MediaStrategyService,
    private readonly mediaAgents: BlindMediaAgentService,
    private readonly receiveQuality: ReceiveQualityPreferenceService,
  ) {}

  initialize(
    ownId: string,
    ownName: string,
    roomId: string,
    icePolicy: IceTierPolicy,
    availableAgents: readonly AvailableMediaAgent[],
    optimization?: OptimizationRuntimeConfig,
    mediaE2ee?: MediaE2eeRuntimeConfig,
  ): void {
    this.close();
    this.ownId = ownId;
    this.ownName = ownName;
    this.roomId = roomId;
    this.icePolicy = icePolicy;
    if (optimization) this.optimization = optimization;
    if (mediaE2ee) this.mediaE2ee = mediaE2ee;
    this.mediaE2eeController = this.mediaE2ee.mode === "disabled" ? null : new MediaE2eeController();
    const e2eeSupported = this.mediaE2eeController?.supported === true;
    this.mediaE2eeState.set(this.mediaE2ee.mode === "disabled"
      ? "disabled"
      : e2eeSupported && this.optimization.dataOverlayEnabled ? "pending" : "unsupported");
    this.connections = new PeerConnectionManager(ownId, icePolicy, this.optimization.dataOverlayEnabled, {
      signal: (to, payload) => this.sendSignal(to, payload),
      track: (peer, track, receiver) => this.acceptRemoteTrack(peer as PeerState, track, receiver),
      channel: (peer, channel) => this.attachChannel(peer as PeerState, channel),
      state: () => this.updateIceState(),
      negotiationError: (peer) => this.addChat("System", `Verhandlung mit ${peer.name} fehlgeschlagen`, true),
    });
    this.mediaAgents.initialize({
      ownPeerId: ownId,
      roomId,
      membershipEpoch: 0,
      icePolicy,
      availableAgents,
      callbacks: {
        attachSender: (sender, contextId, keyId, baseKey) => {
          if (!this.shouldProtectMedia()
            || this.mediaE2eeController?.attachSender(sender, contextId) !== true
            || this.mediaE2eeController.setSenderKey(contextId, keyId, baseKey) !== true) return false;
          this.activeSenderMediaContexts.add(contextId);
          return true;
        },
        acceptTrack: (input) => this.acceptAgentTrack(input),
        trackState: (state) => this.acceptAgentTrackState(state),
        routeChanged: () => {
          this.agentSubscriptionRevisions.clear();
          if (this.membershipStable && this.shouldProtectMedia()) this.rotateMediaKeys();
          else this.clearAllMediaKeys();
          this.reconcileAllPublications();
          this.provisionAgentMediaKeys();
        },
      },
    });
    this.activity.configure(this.optimization.activeSpeakerLimit);
    this.participantNames.set(ownId, ownName);
    this.participantCount.set(1);
    this.startTimers();
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.publishRelayCapability();
    // The first key is generated only after the server-authored membership epoch arrives.
  }

  addPeer(peerId: string, name: string): void {
    if (!peerId || peerId === this.ownId || this.peers.has(peerId)) return;
    const peer = this.connections?.add(peerId, name) as PeerState | null;
    if (!peer) return;
    Object.defineProperty(peer, "overlayQueue", { value: new BoundedOverlayQueue(), enumerable: true });
    this.requestedReceiveProfiles.set(peerId, "auto");
    this.participantNames.set(peerId, peer.name);
    if (this.membershipEpoch() > 0) this.membershipStable = false;
    this.participantCount.set(this.peers.size + 1);
    this.peerChoices.set([...this.peers.values()].map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)));
    this.reconcileAllPublications();
  }

  async acceptSignal(message: ServerMessage): Promise<void> {
    const from = String(message["from"] || "");
    if (!this.peers.has(from)) this.addPeer(from, String(message["fromName"] || "Peer"));
    await this.connections?.acceptSignal(message);
  }

  attachPublication(source: MediaSource, stream: MediaStream): void {
    this.detachPublication(source);
    this.localStreams.set(source, stream);
    for (const track of stream.getTracks()) {
      const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
      const publication: Publication = {
        id: track.id,
        rootPeerId: this.ownId,
        rootName: this.ownName,
        source: trackSource,
        stream,
        track,
        local: true,
        inboundPeerId: "",
      };
      this.publications.set(publication.id, publication);
      this.descriptors.set(publication.id, {
        rootPeerId: publication.rootPeerId,
        rootName: publication.rootName,
        source: publication.source,
      });
      if (track.kind === "audio") this.activity.observe(this.ownId, track);
      this.signaling.send({ type: "media-state", source: trackSource, active: true, trackId: track.id });
      this.reconcilePublication(publication);
      this.provisionAgentMediaKey(publication);
    }
    void this.applyQualityPolicies();
  }

  detachPublication(source: MediaSource): void {
    const stream = this.localStreams.get(source);
    if (!stream) return;
    for (const track of stream.getTracks()) {
      const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
      this.removePublication(track.id);
      this.activity.remove(track.id);
      try { this.signaling.send({ type: "media-state", source: trackSource, active: false }); } catch { /* disconnected */ }
    }
    this.localStreams.delete(source);
    void this.applyQualityPolicies();
  }

  detachPublicationTrack(source: MediaSource, track: MediaStreamTrack): void {
    const stream = this.localStreams.get(source);
    if (!stream || !stream.getTracks().includes(track)) return;
    const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
    this.removePublication(track.id);
    this.activity.remove(track.id);
    try { this.signaling.send({ type: "media-state", source: trackSource, active: false }); } catch { /* disconnected */ }
    stream.removeTrack(track);
    if (stream.getTracks().length === 0) this.localStreams.delete(source);
    void this.applyQualityPolicies();
  }

  announcePublications(): void {
    for (const publication of this.publications.values()) {
      if (!publication.local) continue;
      this.signaling.send({ type: "media-state", source: publication.source, active: true, trackId: publication.track.id });
    }
  }

  updateRemoteSource(message: ServerMessage): void {
    const rootPeerId = String(message["from"] || "");
    const source = String(message["source"] || "") as MediaSource;
    if (message["active"] === true) {
      const trackId = String(message["trackId"] || "");
      for (const [existingId, descriptor] of this.descriptors) {
        if (existingId !== trackId && descriptor.rootPeerId === rootPeerId && descriptor.source === source
          && !this.publications.has(existingId)) this.descriptors.delete(existingId);
      }
      this.descriptors.set(trackId, {
        rootPeerId,
        rootName: String(message["fromName"] || this.peerName(rootPeerId)),
        source,
      });
      const publication = this.publications.get(trackId);
      if (publication && !publication.local) {
        publication.rootPeerId = rootPeerId;
        publication.rootName = this.peerName(rootPeerId);
        publication.source = source;
        this.replaceRemoteView(publication);
        this.reconcilePublication(publication);
      }
      this.refreshAgentSubscriptionIntents();
      return;
    }
    for (const publication of [...this.publications.values()]) {
      if (!publication.local && publication.rootPeerId === rootPeerId && publication.source === source) {
        this.removePublication(publication.id);
      }
    }
    for (const [publicationId, descriptor] of this.descriptors) {
      if (descriptor.rootPeerId === rootPeerId && descriptor.source === source) {
        this.descriptors.delete(publicationId);
        this.mediaAgents.clearSubscriptionIntent(rootPeerId, publicationId);
      }
    }
    this.refreshAgentSubscriptionIntents();
  }

  applyTopology(message: ServerMessage): void {
    const state = this.topology.apply(
      message,
      [this.ownId, ...this.peers.keys()],
      {
        maxChildren: this.optimization.peerRelayMaxChildren,
        maxHops: this.optimization.peerRelayMaxHops,
      },
    );
    if (!state) return;
    const membershipChanged = state.membershipEpoch !== this.membershipEpoch();
    this.topologyEpoch.set(state.topologyEpoch);
    this.membershipEpoch.set(state.membershipEpoch);
    this.routeEpoch.set(state.routeEpoch);
    this.mediaAgents.updateMembershipEpoch(state.membershipEpoch);
    this.membershipStable = true;
    if (membershipChanged && this.optimization.dataOverlayEnabled) {
      this.rotateOverlayKey();
      this.rotateMediaKeys();
    }
    this.topologyMode.set(this.topology.mode(this.ownId));
    this.applyReceivePlaybackPreference();
    this.reconcileAllPublications();
    this.provisionAgentMediaKeys();
  }

  applyMediaAgentState(message: ServerMessage): void {
    if (!this.mediaAgents.applyRoute(message, new Set([this.ownId, ...this.peers.keys()]))) return;
    this.provisionAgentMediaKeys();
    this.reconcileAllPublications();
    this.refreshAgentSubscriptionIntents();
  }

  applyMediaAgentAvailability(message: ServerMessage): void {
    this.mediaAgents.applyAvailability(message);
  }

  applyMediaAgentTakeoverRequest(message: ServerMessage): void {
    this.mediaAgents.applyTakeoverRequest(message);
  }

  async acceptMediaAgentSignal(message: ServerMessage): Promise<void> {
    await this.mediaAgents.acceptSignal(message);
  }

  applyMediaAgentTrackState(message: ServerMessage): void {
    this.mediaAgents.applyTrackState(message);
  }

  applyMediaAgentSubscriptionState(message: ServerMessage): void {
    const state = validateMediaAgentSubscriptionState(message);
    if (!state || state.agentId !== this.mediaAgents.assignedSubscriberAgentId(state.subscriberPeerId)
      || state.routeEpoch !== this.mediaAgents.routeEpoch()) return;
    if (state.subscriberPeerId === this.ownId) {
      const descriptor = this.descriptors.get(state.publicationId);
      if (descriptor && descriptor.rootPeerId !== this.ownId) {
        this.mediaAgents.applySubscriptionState(descriptor.rootPeerId, state);
      }
      return;
    }
    if (!this.peers.has(state.subscriberPeerId) || !this.publications.get(state.publicationId)?.local) return;
    const { publicationId, subscriberPeerId } = state;
    const subscriptionKey = `${publicationId}\0${subscriberPeerId}`;
    const previousRevision = this.agentSubscriptionRevisions.get(subscriptionKey) || 0;
    if (state.revision < previousRevision) return;
    this.agentSubscriptionRevisions.set(subscriptionKey, state.revision);
    let peers = this.agentSubscriptionReady.get(publicationId);
    if (!peers) {
      peers = new Set();
      this.agentSubscriptionReady.set(publicationId, peers);
    }
    if (state.ready) peers.add(subscriberPeerId); else peers.delete(subscriberPeerId);
    const publication = this.publications.get(publicationId);
    if (publication) this.reconcilePublication(publication);
  }

  setOptimizationMode(mode: OptimizationMode): void {
    this.mediaStrategy.setOptimizationMode(mode);
    void this.applyQualityPolicies(true);
  }

  refreshMediaStrategy(): void {
    void this.applyQualityPolicies(true);
    this.refreshAgentSubscriptionIntents();
  }

  setReceiveQualityProfile(value: unknown): boolean {
    if (!this.receiveQuality.setProfile(value)) return false;
    this.applyReceivePlaybackPreference();
    for (const peer of this.peers.values()) this.sendReceiveQualityTo(peer);
    void this.applyQualityPolicies(true);
    this.refreshAgentSubscriptionIntents();
    return true;
  }

  refreshAgentSubscriptionIntents(): void {
    const activeIds = this.focusPeerIds();
    const screenActive = [...this.descriptors.values()].some(({ source }) => source === "screen");
    const receiveProfile = this.receiveQuality.profile();
    const videoEnabled = receiveVideoEnabled(receiveProfile);
    const maximumVideoLayer = mediaAgentCameraLayerCeiling(receiveProfile);
    for (const [publicationId, descriptor] of this.descriptors) {
      if (descriptor.rootPeerId === this.ownId) continue;
      let enabled = true;
      let preferredLayer: MediaAgentLayer;
      let maximumLayer: MediaAgentLayer;
      if (descriptor.source === "microphone" || descriptor.source === "screen-audio") {
        preferredLayer = "audio";
        maximumLayer = "audio";
      } else if (descriptor.source === "screen") {
        enabled = videoEnabled;
        preferredLayer = "single";
        maximumLayer = "single";
      } else {
        const quality = selectVideoQuality({
          source: descriptor.source,
          speakerRank: activeIds.indexOf(descriptor.rootPeerId),
          participantCount: this.participantCount(),
          mode: this.optimizationMode(),
          linkClass: this.linkSummary(),
          screenActive,
        });
        enabled = videoEnabled && quality.active;
        const desired = agentLayerForTier(quality.tier);
        preferredLayer = AGENT_VIDEO_LAYER_RANK[desired] > AGENT_VIDEO_LAYER_RANK[maximumVideoLayer]
          ? maximumVideoLayer : desired;
        maximumLayer = maximumVideoLayer;
      }
      this.mediaAgents.setSubscriptionIntent({
        publisherPeerId: descriptor.rootPeerId,
        publicationId,
        source: descriptor.source,
        enabled,
        preferredLayer,
        maximumLayer,
      });
    }
  }

  setRelayConsent(enabled: boolean): void {
    if (!this.optimization.peerRelayEnabled || !this.ownId || this.mediaE2ee.mode !== "disabled") return;
    this.signaling.send({ type: "relay-consent", enabled });
    this.relayConsent.set(enabled);
    if (!enabled) this.relayCapability.set("idle");
  }

  announceOverlayKey(): void {
    if (!this.overlayPublicKey || !this.optimization.dataOverlayEnabled) return;
    try { this.signaling.send({ type: "overlay-key", key: this.overlayPublicKey }); } catch { /* disconnected */ }
  }

  async acceptOverlayKey(message: ServerMessage): Promise<void> {
    const peerId = String(message["from"] || "");
    try {
      if (Number(message["membershipEpoch"]) !== this.membershipEpoch() || !this.peers.has(peerId)) return;
      await this.overlayInitialization;
      await this.overlay.setPeerKey(peerId, message["key"] as JsonWebKey);
      this.updateOverlayAvailability();
      this.provisionMediaKeysForPeer(peerId);
    } catch {
      this.addChat("System", "Ungültiger Overlay-Schlüssel wurde verworfen", true);
    }
  }

  private rotateOverlayKey(): void {
    const generation = ++this.overlayGeneration;
    this.overlayReady.set(false);
    this.overlayPublicKey = null;
    this.overlayInitialization = this.overlayInitialization.catch(() => undefined).then(async () => {
      if (generation !== this.overlayGeneration || !this.ownId) return;
      const key = await this.overlay.initialize(this.ownId);
      if (generation !== this.overlayGeneration || !this.ownId) {
        this.overlay.destroy();
        return;
      }
      this.overlayPublicKey = key;
      this.announceOverlayKey();
    }).catch(() => {
      if (generation === this.overlayGeneration) this.overlayMode.set("unavailable");
    });
  }

  async sendOverlayData(destinationPeerId: string, data: Uint8Array, trafficClass: OverlayTrafficClass): Promise<boolean> {
    if (!this.optimization.dataOverlayEnabled || !this.peers.has(destinationPeerId)
      || this.membershipEpoch() < 1 || this.routeEpoch() < 1) return false;
    const routedPath = this.topology.path(this.ownId, destinationPeerId);
    const preferredPath = routedPath && routedPath.length <= 5 ? routedPath : [this.ownId, destinationPeerId];
    const firstHop = preferredPath[1];
    const path = this.peers.get(firstHop)?.channels.get("overlay")?.readyState === "open"
      ? preferredPath : [this.ownId, destinationPeerId];
    try {
      const packets = await this.overlay.encrypt(destinationPeerId, data, {
        membershipEpoch: this.membershipEpoch(),
        routeEpoch: this.routeEpoch(),
        trafficClass,
        path,
      });
      this.overlayMode.set(path.length > 2 ? "opaque-relay" : "direct-encrypted");
      return packets.every((packet) => this.queueOverlayPacket(path[1], packet));
    } catch {
      return false;
    }
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.membershipStable = false;
    this.clearAllMediaKeys();
    peer.overlayQueue.clear();
    this.connections?.remove(peerId);
    this.overlay.removePeer(peerId);
    this.updateOverlayAvailability();
    this.participantNames.delete(peerId);
    this.activity.removePeer(peerId);
    this.requestedReceiveProfiles.delete(peerId);
    this.sentReceiveProfiles.delete(peerId);
    for (const publication of [...this.publications.values()]) {
      if (!publication.local && publication.inboundPeerId === peerId) this.removePublication(publication.id);
    }
    this.remoteMedia.update((items) => items.filter((item) => item.transportPeerId !== peerId));
    this.participantCount.set(this.peers.size + (this.ownId ? 1 : 0));
    this.peerChoices.set([...this.peers.values()].map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)));
    this.updateIceState();
  }

  sendChat(text: string): void {
    const value = text.trim();
    if (!value || value.length > 2_000) return;
    const payload = JSON.stringify({ version: 1, type: "chat", text: value });
    for (const peer of this.peers.values()) {
      const channel = peer.channels.get("chat");
      if (channel?.readyState === "open" && channel.bufferedAmount < CHAT_BUFFER_LIMIT) channel.send(payload);
    }
    this.addChat(this.ownName || "Du", value, false);
  }

  close(): void {
    this.stopTimers();
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.topology.clear();
    this.clearAllMediaKeys();
    this.mediaAgents.close();
    this.mediaE2eeController?.destroy();
    this.mediaE2eeController = null;
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.connections?.close();
    this.connections = null;
    this.remoteMedia.set([]);
    this.publications.clear();
    this.descriptors.clear();
    this.requestedReceiveProfiles.clear();
    this.sentReceiveProfiles.clear();
    this.localStreams.clear();
    this.overlay.destroy();
    this.overlayGeneration += 1;
    this.overlayInitialization = Promise.resolve();
    this.overlayPublicKey = null;
    this.overlayDeliveries.set([]);
    this.overlayMode.set("unavailable");
    this.overlayReady.set(false);
    this.peerChoices.set([]);
    this.participantNames.clear();
    this.activity.close();
    this.ownId = "";
    this.roomId = "";
    this.participantCount.set(0);
    this.iceState.set("idle");
    this.icePath.set("unknown");
    this.mediaE2eeState.set("disabled");
    this.membershipStable = false;
    this.topologyMode.set("adaptive_mesh");
    this.topologyEpoch.set(0);
    this.membershipEpoch.set(0);
    this.routeEpoch.set(0);
    this.relayConsent.set(false);
    this.localQuality.set("idle");
    this.linkSummary.set("unknown");
  }

  private focusPeerIds(): readonly string[] {
    const active = this.activeSpeakerIds();
    if (active.length > 0) return active.slice(0, this.optimization.activeSpeakerLimit);
    return [...new Set(this.remoteMedia().filter((item) => item.source === "camera").map((item) => item.peerId))]
      .sort()
      .slice(0, this.optimization.activeSpeakerLimit);
  }

  private peerName(peerId: string): string {
    return this.participantNames.get(peerId) || (peerId === this.ownId ? this.ownName : "Peer");
  }

  private sendSignal(to: string, payload: object): void {
    this.signaling.send({ type: "signal", to, ...payload });
  }

  private publishRelayCapability(): void {
    if (!this.optimization.peerRelayEnabled || !this.ownId || this.mediaE2ee.mode !== "disabled") return;
    const connection = (navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean };
    }).connection;
    const network = connection?.saveData || connection?.effectiveType === "2g"
      ? "constrained"
      : connection?.effectiveType === "4g" ? "fast" : "unknown";
    const cores = navigator.hardwareConcurrency || 2;
    try {
      this.signaling.send({
        type: "relay-capability",
        visible: !document.hidden,
        battery: "unknown",
        network,
        selfCapacity: Math.max(25, Math.min(100, cores * 12)),
      });
    } catch { /* signaling may already be closing */ }
  }

  private acceptAgentTrack(input: AgentTrackInput): boolean {
    const descriptor = this.descriptors.get(input.publicationId);
    if (!descriptor || descriptor.rootPeerId !== input.publisherPeerId || input.publisherPeerId === this.ownId
      || input.agentId !== this.mediaAgents.assignedSubscriberAgentId(this.ownId)
      || !this.peers.has(input.publisherPeerId) || !this.shouldProtectMedia()) return false;
    const contextId = this.inboundMediaContext(input.publisherPeerId, input.publicationId);
    if (this.mediaE2eeController?.attachReceiver(input.receiver, contextId) !== true) {
      if (this.mediaE2ee.mode === "required") this.mediaE2eeState.set("unsupported");
      return false;
    }
    const existing = this.publications.get(input.publicationId);
    if (existing?.local) return false;
    if (existing) this.discardInboundForReplacement(existing);
    const publication: Publication = {
      id: input.publicationId,
      rootPeerId: input.publisherPeerId,
      rootName: descriptor.rootName,
      source: descriptor.source,
      stream: new MediaStream([input.track]),
      track: input.track,
      local: false,
      inboundPeerId: `agent:${input.agentId}`,
    };
    this.publications.set(publication.id, publication);
    this.applyReceivePlaybackPreference();
    this.replaceRemoteView(publication);
    if (input.track.kind === "audio") this.activity.observe(publication.rootPeerId, input.track);
    input.track.onended = () => {
      if (this.publications.get(publication.id)?.track === input.track) this.removePublication(publication.id);
    };
    this.refreshMediaE2eeState();
    return true;
  }

  private acceptAgentTrackState(state: MediaAgentTrackState): void {
    if (state.peerId === this.ownId) return;
    if (state.active) {
      const known = this.descriptors.get(state.publicationId);
      if (!known) this.descriptors.set(state.publicationId, {
        rootPeerId: state.peerId,
        rootName: this.peerName(state.peerId),
        source: state.source,
      });
      this.refreshAgentSubscriptionIntents();
      return;
    }
    this.descriptors.delete(state.publicationId);
    this.mediaAgents.clearSubscriptionIntent(state.peerId, state.publicationId);
    const publication = this.publications.get(state.publicationId);
    if (publication && !publication.local && publication.inboundPeerId === `agent:${state.agentId}`) {
      this.removePublication(publication.id);
    }
  }

  private discardInboundForReplacement(publication: Publication): void {
    for (const peer of this.peers.values()) {
      const sender = peer.senders.get(publication.id);
      if (sender) peer.pc.removeTrack(sender);
      peer.senders.delete(publication.id);
      peer.appliedTiers.delete(publication.id);
    }
    this.publications.delete(publication.id);
    this.remoteMedia.update((items) => items.filter((item) => item.key !== publication.id));
    this.activity.remove(publication.track.id);
  }

  private acceptRemoteTrack(peer: PeerState, track: MediaStreamTrack, receiver: RTCRtpReceiver): void {
    const directDescriptor = this.descriptors.get(track.id);
    const fallbackDescriptor = directDescriptor ? null : [...this.descriptors.entries()].find(([publicationId, value]) => (
      value.rootPeerId === peer.id && sourceKind(value.source) === track.kind && !this.publications.has(publicationId)
    ));
    const publicationId = directDescriptor ? track.id : fallbackDescriptor?.[0] || track.id;
    const descriptor = directDescriptor || fallbackDescriptor?.[1];
    const current = this.publications.get(publicationId);
    if (current && !current.local && current.inboundPeerId.startsWith("agent:")
      && this.mediaAgents.assignedAgentId(current.rootPeerId)) {
      track.enabled = false;
      return;
    }
    const publication: Publication = {
      id: publicationId,
      rootPeerId: descriptor?.rootPeerId || peer.id,
      rootName: descriptor?.rootName || peer.name,
      source: descriptor?.source || (track.kind === "audio" ? "microphone" : "camera"),
      stream: new MediaStream([track]),
      track,
      local: false,
      inboundPeerId: peer.id,
    };
    if (this.shouldProtectMedia()) {
      const attached = this.mediaE2eeController?.attachReceiver(
        receiver,
        this.inboundMediaContext(publication.rootPeerId, publication.id),
      ) === true;
      if (!attached && this.mediaE2ee.mode === "required") {
        track.enabled = false;
        this.mediaE2eeState.set("unsupported");
        return;
      }
    }
    if (current && !current.local) this.discardInboundForReplacement(current);
    this.publications.set(publication.id, publication);
    this.applyReceivePlaybackPreference();
    this.replaceRemoteView(publication);
    if (track.kind === "audio") this.activity.observe(publication.rootPeerId, track);
    track.onended = () => {
      if (this.publications.get(publication.id)?.track === track) this.removePublication(publication.id);
    };
    this.reconcilePublication(publication);
    if (track.kind === "video" && this.routeChildren(publication.rootPeerId, this.ownId).size > 0) {
      this.relayCapability.set("available");
    }
  }

  private replaceRemoteView(publication: Publication): void {
    const entry: RemoteMediaView = {
      key: publication.id,
      peerId: publication.rootPeerId,
      peerName: publication.rootName,
      transportPeerId: publication.inboundPeerId,
      source: publication.source,
      stream: publication.stream,
      kind: publication.track.kind as "audio" | "video",
    };
    this.remoteMedia.update((items) => [...items.filter((item) => item.key !== entry.key), entry]);
  }

  private removePublication(publicationId: string): void {
    const publication = this.publications.get(publicationId);
    if (!publication) return;
    if (publication.local) this.clearAgentPublicationKey(publication.id);
    this.mediaAgents.deactivatePublication(publication.id);
    this.agentSubscriptionReady.delete(publication.id);
    for (const key of this.agentSubscriptionRevisions.keys()) {
      if (key.startsWith(`${publication.id}\0`)) this.agentSubscriptionRevisions.delete(key);
    }
    this.clearPublicationMediaKeys(publication);
    for (const peer of this.peers.values()) {
      const sender = peer.senders.get(publicationId);
      if (sender) peer.pc.removeTrack(sender);
      peer.senders.delete(publicationId);
      peer.appliedTiers.delete(publicationId);
    }
    this.publications.delete(publicationId);
    if (publication.local || !publication.inboundPeerId.startsWith("agent:")) {
      this.descriptors.delete(publicationId);
    }
    this.remoteMedia.update((items) => items.filter((item) => item.key !== publicationId));
    this.activity.remove(publication.track.id);
  }

  private routeChildren(rootPeerId: string, parentPeerId: string): ReadonlySet<string> {
    return this.topology.children(rootPeerId, parentPeerId);
  }

  private shouldSend(publication: Publication, targetPeerId: string): boolean {
    if (this.mediaE2ee.mode !== "disabled") {
      return publication.local && !this.agentSubscriptionReadyFor(publication.id, targetPeerId);
    }
    return this.relay.shouldSend({
      trackKind: publication.track.kind,
      publicationLocal: publication.local,
      rootPeerId: publication.rootPeerId,
      ownPeerId: this.ownId,
      targetPeerId,
    });
  }

  private reconcileAllPublications(): void {
    for (const publication of this.publications.values()) this.reconcilePublication(publication);
  }

  private reconcilePublication(publication: Publication): void {
    for (const peer of this.peers.values()) {
      const existing = peer.senders.get(publication.id);
      const shouldSend = this.shouldSend(publication, peer.id);
      if (!shouldSend && existing) {
        peer.pc.removeTrack(existing);
        peer.senders.delete(publication.id);
        peer.appliedTiers.delete(publication.id);
      } else if (shouldSend && !existing && publication.track.readyState === "live") {
        if (this.mediaE2ee.mode === "required" && !this.shouldProtectMedia()) {
          this.mediaE2eeState.set("unsupported");
          continue;
        }
        try {
          const sender = peer.pc.addTrack(publication.track, publication.stream);
          if (this.shouldProtectMedia()) {
            const contextId = this.outboundMediaContext(publication.id, peer.id);
            if (!this.mediaE2eeController?.attachSender(sender, contextId)) {
              peer.pc.removeTrack(sender);
              this.mediaE2eeState.set("unsupported");
              continue;
            }
          }
          peer.senders.set(publication.id, sender);
          this.provisionMediaKey(publication, peer);
          if (!publication.local) this.relayCapability.set("available");
        } catch {
          if (!publication.local) {
            this.relayCapability.set("unsupported");
            if (this.relayConsent()) this.setRelayConsent(false);
          }
        }
      }
    }
    void this.applyQualityPolicies();
  }

  private queueOverlayPacket(peerId: string, packet: OverlayPacket): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    const payload = JSON.stringify(packet);
    const accepted = peer.overlayQueue.enqueue(packet.trafficClass, payload);
    this.flushOverlayQueue(peer);
    return accepted;
  }

  private flushOverlayQueue(peer: PeerState): void {
    const channel = peer.channels.get("overlay");
    if (!channel || channel.readyState !== "open") return;
    peer.overlayQueue.flush((payload) => {
      if (channel.bufferedAmount + payload.length > 1024 * 1024) return false;
      channel.send(payload);
      return true;
    });
  }

  private async acceptOverlayPacket(peer: PeerState, raw: unknown): Promise<void> {
    let value: unknown;
    try { value = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return; }
    const result = await this.overlay.receive(value, peer.id, {
      membershipEpoch: this.membershipEpoch(),
      routeEpoch: this.routeEpoch(),
      memberPeerIds: new Set([this.ownId, ...this.peers.keys()]),
    });
    if (result.action === "forward") this.queueOverlayPacket(result.nextPeerId, result.packet);
    if (result.action === "pending") {
      void this.sendOverlayAck(result.originPeerId, result.packetId, result.missing);
    }
    if (result.action === "delivered") {
      if (result.trafficClass === "control") {
        try {
          const acknowledgement = JSON.parse(new TextDecoder().decode(result.data)) as Record<string, unknown>;
          if (acknowledgement["version"] === 1 && acknowledgement["type"] === "overlay-ack"
            && typeof acknowledgement["packetId"] === "string" && Array.isArray(acknowledgement["missing"])
            && acknowledgement["missing"].every((index) => Number.isSafeInteger(index))) {
            for (const packet of this.overlay.resume(
              acknowledgement["packetId"], acknowledgement["missing"] as number[],
            )) this.queueOverlayPacket(packet.path[1], packet);
            return;
          }
        } catch { /* normal encrypted control payload */ }
      }
      void this.sendOverlayAck(result.originPeerId, result.packetId, []);
      if (result.trafficClass === "rekey") {
        void this.acceptMediaE2eeEnvelope(result.originPeerId, result.data);
        return;
      }
      this.overlayDeliveries.update((items) => [...items.slice(-63), {
        id: ++this.overlaySerial,
        originPeerId: result.originPeerId,
        trafficClass: result.trafficClass,
        data: result.data,
      }]);
    }
  }

  private async sendOverlayAck(originPeerId: string, packetId: string, missing: readonly number[]): Promise<void> {
    await this.sendOverlayData(originPeerId, new TextEncoder().encode(JSON.stringify({
      version: 1,
      type: "overlay-ack",
      packetId,
      missing: missing.slice(0, 96),
    })), "control");
  }

  private attachChannel(peer: PeerState, channel: RTCDataChannel): void {
    if (channel.label !== "chat" && channel.label !== "control" && channel.label !== "overlay") {
      channel.close();
      return;
    }
    const kind = channel.label;
    peer.channels.get(kind)?.close();
    peer.channels.set(kind, channel);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = kind === "control"
      ? CONTROL_BUFFER_LIMIT / 2 : kind === "chat" ? CHAT_BUFFER_LIMIT / 2 : 256 * 1024;
    channel.onbufferedamountlow = () => {
      if (kind === "overlay") this.flushOverlayQueue(peer);
    };
    channel.onopen = () => {
      if (kind === "chat") this.addChat("System", `${peer.name}: Peer-Chat verbunden`, true);
      else if (kind === "control") {
        this.sendActivityTo(peer);
        this.sendReceiveQualityTo(peer, true);
      }
      else {
        this.flushOverlayQueue(peer);
        this.updateOverlayAvailability();
        this.provisionMediaKeysForPeer(peer.id);
      }
    };
    channel.onmessage = ({ data }) => {
      if (kind === "overlay") {
        void this.acceptOverlayPacket(peer, data);
        return;
      }
      if (kind === "chat") {
        const message = parsePeerChat(data);
        if (message) this.addChat(peer.name, message.text, false);
        return;
      }
      const message = parsePeerControl(data);
      if (!message || message.sequence <= peer.lastControlSequence) return;
      peer.lastControlSequence = message.sequence;
      if (message.type === "activity") this.activity.acceptPeerLevel(peer.id, message.level);
      else if (message.type === "quality") peer.reportedLinkClass = message.linkClass;
      else if (this.requestedReceiveProfiles.get(peer.id) !== message.profile) {
        // The bounded 500 ms policy cycle coalesces rapid peer changes and applies only the
        // latest per-target ceiling instead of letting control traffic trigger encoder work.
        this.requestedReceiveProfiles.set(peer.id, message.profile);
      }
    };
  }

  private updateOverlayAvailability(): void {
    this.overlayReady.set([...this.peers.values()].some((peer) => (
      peer.channels.get("overlay")?.readyState === "open" && this.overlay.hasPeerKey(peer.id)
    )));
  }

  private sendActivityTo(peer: PeerState): void {
    const channel = peer.channels.get("control");
    if (channel?.readyState !== "open" || channel.bufferedAmount >= CONTROL_BUFFER_LIMIT) return;
    channel.send(JSON.stringify({ version: 1, type: "activity", sequence: ++this.controlSequence, level: Math.round(this.activity.level(this.ownId) * 1000) / 1000 }));
  }

  private sendQualityTo(peer: PeerState): void {
    const channel = peer.channels.get("control");
    if (channel?.readyState !== "open" || channel.bufferedAmount >= CONTROL_BUFFER_LIMIT) return;
    channel.send(JSON.stringify({ version: 1, type: "quality", sequence: ++this.controlSequence, linkClass: peer.linkClass }));
  }

  private sendReceiveQualityTo(peer: PeerState, force = false): void {
    const channel = peer.channels.get("control");
    if (channel?.readyState !== "open" || channel.bufferedAmount >= CONTROL_BUFFER_LIMIT) return;
    const profile = this.receiveQuality.profile();
    if (!force && this.sentReceiveProfiles.get(peer.id) === profile) return;
    try {
      channel.send(JSON.stringify({
        version: 1,
        type: "receive-quality",
        sequence: ++this.controlSequence,
        profile,
      }));
      this.sentReceiveProfiles.set(peer.id, profile);
    } catch { /* a later quality sample retries while the channel remains open */ }
  }

  private startTimers(): void {
    this.activityTimer = setInterval(() => {
      for (const peer of this.peers.values()) this.sendActivityTo(peer);
      void this.applyQualityPolicies();
    }, 500);
    this.qualityTimer = setInterval(() => void this.sampleQuality(), 2_000);
  }

  private stopTimers(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.activityTimer = null;
    this.qualityTimer = null;
  }

  private async sampleQuality(): Promise<void> {
    for (const peer of this.peers.values()) {
      this.sendReceiveQualityTo(peer);
      try {
        const { availableOutgoingBitrate, roundTripTime, lossRatio } = await this.quality.sample(peer);
        peer.healthSamples = Math.min(10_000, peer.healthSamples + 1);
        const receivesRelayedPublication = [...this.publications.values()].some((publication) => (
          !publication.local && publication.inboundPeerId === peer.id && publication.rootPeerId !== peer.id
        ));
        if (receivesRelayedPublication && this.routeEpoch() > 0) {
          const deliveryRatio = Math.max(0, Math.min(1, 1 - (lossRatio || 0)));
          const bitrate = availableOutgoingBitrate || 0;
          const observedCapacity = bitrate >= 2_000_000 ? 100 : bitrate >= 750_000 ? 70 : bitrate >= 250_000 ? 40 : 20;
          try {
            this.signaling.send({
              type: "relay-observation",
              relayPeerId: peer.id,
              routeEpoch: this.routeEpoch(),
              sampleCount: peer.healthSamples,
              deliveryRatio,
              delayMs: Math.max(0, Math.min(60_000, (roundTripTime || 0) * 1000)),
              observedCapacity,
            });
          } catch { /* disconnected */ }
        }
        this.sendQualityTo(peer);
      } catch {
        peer.linkClass = "unknown";
      }
    }
    const classes = [...this.peers.values()].map((peer) => worseLink(peer.linkClass, peer.reportedLinkClass));
    this.linkSummary.set(classes.reduce(worseLink, "unknown"));
    await this.applyQualityPolicies();
  }

  private async applyQualityPolicies(force = false): Promise<void> {
    const activeIds = this.activeSpeakerIds();
    const fallbackOrder = [this.ownId, ...[...this.peers.keys()].sort()];
    const screenActive = [...this.publications.values()].some((item) => item.source === "screen");
    let ownQuality: VideoTier | "audio-only" | "idle" = [...this.publications.values()].some((item) => item.local && item.track.kind === "audio") ? "audio-only" : "idle";
    for (const peer of this.peers.values()) {
      const linkClass = worseLink(peer.linkClass, peer.reportedLinkClass);
      for (const [publicationId, sender] of peer.senders) {
        const publication = this.publications.get(publicationId);
        if (!publication || !sender.track) continue;
        if (sender.track.kind === "audio") {
          const capability = await this.quality.applyAudio(
            peer,
            publicationId,
            sender,
            this.mediaStrategy.senderPolicy(publication.source),
            force,
          );
          if (capability) this.qualityCapability.set(capability);
          continue;
        }
        const ranked = activeIds.length > 0 ? activeIds : fallbackOrder;
        const quality = selectVideoQuality({
          source: publication.source,
          speakerRank: ranked.indexOf(publication.rootPeerId),
          participantCount: this.participantCount(),
          mode: this.optimizationMode(),
          linkClass,
          screenActive,
        });
        const prioritizedQuality = this.mediaStrategy.prioritizeVideo(publication.source, quality);
        const targetQuality = capVideoQualityForReceiver(
          publication.source,
          prioritizedQuality,
          this.requestedReceiveProfileFor(publication, peer.id),
        );
        const capability = await this.quality.applyVideo(
          peer,
          publicationId,
          sender,
          publication.source,
          targetQuality,
          this.mediaStrategy.priority(publication.source),
          force,
        );
        if (capability) this.qualityCapability.set(capability);
        if (publication.local && (ownQuality === "idle" || publication.source === "screen" || publication.source === "camera")) ownQuality = prioritizedQuality.tier;
      }
    }
    for (const publication of this.publications.values()) {
      if (!publication.local) continue;
      const target = this.mediaAgents.qualityTarget(publication.id);
      if (!target || !target.sender.track) continue;
      if (target.sender.track.kind === "audio") {
        const capability = await this.quality.applyAudio(
          target.peer,
          publication.id,
          target.sender,
          this.mediaStrategy.senderPolicy(publication.source),
          force,
        );
        if (capability) this.qualityCapability.set(capability);
        continue;
      }
      const ranked = activeIds.length > 0 ? activeIds : fallbackOrder;
      const quality = publication.source === "camera"
        ? (target.peer.linkClass === "critical" ? QUALITY_SETTINGS.thumbnail
          : target.peer.linkClass === "constrained" || this.optimizationMode() === "data-saver"
            ? QUALITY_SETTINGS.balanced : QUALITY_SETTINGS.focus)
        : selectVideoQuality({
          source: publication.source,
          speakerRank: ranked.indexOf(publication.rootPeerId),
          participantCount: this.participantCount(),
          mode: this.optimizationMode(),
          linkClass: target.peer.linkClass,
          screenActive,
        });
      const prioritizedQuality = this.mediaStrategy.prioritizeVideo(publication.source, quality);
      const capability = await this.quality.applyVideo(
        target.peer,
        publication.id,
        target.sender,
        publication.source,
        prioritizedQuality,
        this.mediaStrategy.priority(publication.source),
        force,
      );
      if (capability) this.qualityCapability.set(capability);
      if (ownQuality === "idle" || publication.source === "screen" || publication.source === "camera") {
        ownQuality = prioritizedQuality.tier;
      }
    }
    this.localQuality.set(ownQuality);
    this.refreshAgentSubscriptionIntents();
  }

  private requestedReceiveProfileFor(publication: Publication, targetPeerId: string): ReceiveQualityProfile {
    // A legacy trusted relay needs one upstream rendition for its descendants. Letting its
    // local preference lower that shared input would silently lower other recipients too.
    if (this.routeChildren(publication.rootPeerId, targetPeerId).size > 0) return "auto";
    return this.requestedReceiveProfiles.get(targetPeerId) || "auto";
  }

  private applyReceivePlaybackPreference(): void {
    const videoEnabled = receiveVideoEnabled(this.receiveQuality.profile());
    for (const publication of this.publications.values()) {
      if (publication.local || publication.track.kind !== "video") continue;
      const sharedRelayInput = this.routeChildren(publication.rootPeerId, this.ownId).size > 0;
      publication.track.enabled = videoEnabled || sharedRelayInput;
    }
  }

  private addChat(author: string, text: string, system: boolean): void {
    this.chat.update((entries) => [...entries.slice(-199), { id: ++this.chatSerial, author, text, system }]);
  }

  private updateIceState(): void {
    const states = [...this.peers.values()].map((peer) => peer.pc.iceConnectionState);
    if (states.length === 0) this.iceState.set("idle");
    else if (states.some((state) => state === "failed")) this.iceState.set("failed");
    else if (states.some((state) => state === "connected" || state === "completed")) this.iceState.set("connected");
    else this.iceState.set(states[0] || "new");
    const paths = [...this.peers.values()].map((peer) => peer.icePath);
    if (paths.includes("infrastructure-relay")) this.icePath.set("infrastructure-relay");
    else if (paths.includes("peer-edge")) this.icePath.set("peer-edge");
    else if (paths.includes("direct")) this.icePath.set("direct");
    else this.icePath.set("unknown");
  }

  private agentSubscriptionReadyFor(publicationId: string, targetPeerId: string): boolean {
    const state = this.agentMediaKeys.get(publicationId);
    const subscribed = this.agentSubscriptionReady.get(publicationId) || new Set<string>();
    return Boolean(state?.active && state.agentId === this.mediaAgents.assignedAgentId(this.ownId)
      && state.routeEpoch === this.mediaAgents.routeEpoch()
      && this.mediaAgents.routeReady(state.agentId, new Set([this.ownId]))
      && this.peers.has(targetPeerId) && subscribed.has(targetPeerId));
  }

  private shouldProtectMedia(): boolean {
    return this.mediaE2ee.mode !== "disabled"
      && this.optimization.dataOverlayEnabled
      && this.mediaE2eeController?.supported === true;
  }

  private outboundMediaContext(publicationId: string, targetPeerId: string): string {
    return `out:${publicationId}:${targetPeerId}`;
  }

  private inboundMediaContext(senderPeerId: string, publicationId: string): string {
    return `in:${senderPeerId}:${publicationId}`;
  }

  private agentOutboundMediaContext(publicationId: string, agentId: string, routeEpoch: number): string {
    return `agent-out:${publicationId}:${agentId}:${routeEpoch}`;
  }

  private provisionAgentMediaKeys(): void {
    for (const publication of this.publications.values()) this.provisionAgentMediaKey(publication);
  }

  private provisionAgentMediaKey(publication: Publication): void {
    const agentId = this.mediaAgents.assignedAgentId(this.ownId);
    const agentRouteEpoch = this.mediaAgents.routeEpoch();
    if (!publication.local || !agentId || this.peers.size === 0 || !this.shouldProtectMedia()
      || !this.membershipStable || this.membershipEpoch() < 1 || agentRouteEpoch < 1
      || [...this.peers.keys()].some((peerId) => !this.overlay.hasPeerKey(peerId))) return;
    const current = this.agentMediaKeys.get(publication.id);
    if (current?.message.membershipEpoch === this.membershipEpoch()
      && current.agentId === agentId && current.routeEpoch === agentRouteEpoch) return;
    if (current) this.clearAgentPublicationKey(publication.id);
    const generated = randomMediaKey();
    const contextId = this.agentOutboundMediaContext(publication.id, agentId, agentRouteEpoch);
    const state: AgentMediaKeyState = {
      contextId,
      agentId,
      routeEpoch: agentRouteEpoch,
      message: createMediaAgentKeyMessage({
        publicationId: publication.id,
        senderPeerId: this.ownId,
        agentId,
        membershipEpoch: this.membershipEpoch(),
        routeEpoch: agentRouteEpoch,
        keyId: generated.keyId,
        baseKey: generated.baseKey,
      }),
      baseKey: generated.baseKey,
      acknowledgedPeerIds: new Set(),
      retries: 0,
      timer: null,
      active: false,
    };
    this.agentMediaKeys.set(publication.id, state);
    this.mediaE2eeState.set("pending");
    void this.sendAgentMediaKey(state);
  }

  private async sendAgentMediaKey(state: AgentMediaKeyState): Promise<void> {
    if (this.agentMediaKeys.get(state.message.publicationId) !== state || state.active
      || state.message.membershipEpoch !== this.membershipEpoch()
      || state.routeEpoch !== this.mediaAgents.routeEpoch() || !this.membershipStable) return;
    await Promise.all([...this.peers.keys()]
      .filter((peerId) => !state.acknowledgedPeerIds.has(peerId))
      .map((peerId) => this.sendOverlayData(
        peerId,
        new TextEncoder().encode(JSON.stringify(state.message)),
        "rekey",
      )));
    state.retries += 1;
    if (state.retries >= 60 || this.agentMediaKeys.get(state.message.publicationId) !== state) return;
    state.timer = setTimeout(() => void this.sendAgentMediaKey(state), 1_000);
  }

  private activateAgentMediaKey(state: AgentMediaKeyState): void {
    const publication = this.publications.get(state.message.publicationId);
    if (!publication?.local || state.active || [...this.peers.keys()].some((peerId) => (
      !state.acknowledgedPeerIds.has(peerId)
    ))) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.active = this.mediaAgents.activatePublication({
      agentId: state.agentId,
      publicationId: publication.id,
      stream: publication.stream,
      track: publication.track,
      source: publication.source,
      contextId: state.contextId,
      keyId: state.message.keyId,
      baseKey: state.baseKey,
    });
    if (state.active) {
      this.activeSenderMediaContexts.add(state.contextId);
      this.refreshMediaE2eeState();
      void this.applyQualityPolicies(true);
    }
  }

  private provisionMediaKeysForPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const publication of this.publications.values()) {
      if (publication.local && peer.senders.has(publication.id)) this.provisionMediaKey(publication, peer);
    }
  }

  private provisionMediaKey(publication: Publication, peer: PeerState): void {
    if (!publication.local || !this.shouldProtectMedia() || !this.membershipStable
      || this.membershipEpoch() < 1 || this.routeEpoch() < 1 || !this.overlay.hasPeerKey(peer.id)) return;
    const contextId = this.outboundMediaContext(publication.id, peer.id);
    const current = this.pendingMediaKeys.get(contextId);
    if (current?.message.membershipEpoch === this.membershipEpoch()) return;
    if (current) this.destroyPendingMediaKey(current);
    const generated = randomMediaKey();
    const message = createMediaKeyMessage({
      publicationId: publication.id,
      senderPeerId: this.ownId,
      membershipEpoch: this.membershipEpoch(),
      keyId: generated.keyId,
      baseKey: generated.baseKey,
    });
    const pending: PendingMediaKey = {
      contextId,
      targetPeerId: peer.id,
      message,
      baseKey: generated.baseKey,
      retries: 0,
      timer: null,
    };
    this.pendingMediaKeys.set(contextId, pending);
    this.mediaE2eeState.set("pending");
    void this.sendPendingMediaKey(pending);
  }

  private async sendPendingMediaKey(pending: PendingMediaKey): Promise<void> {
    if (this.pendingMediaKeys.get(pending.contextId) !== pending
      || pending.message.membershipEpoch !== this.membershipEpoch() || !this.membershipStable) return;
    await this.sendOverlayData(
      pending.targetPeerId,
      new TextEncoder().encode(JSON.stringify(pending.message)),
      "rekey",
    );
    pending.retries += 1;
    if (pending.retries >= 60 || this.pendingMediaKeys.get(pending.contextId) !== pending) return;
    pending.timer = setTimeout(() => void this.sendPendingMediaKey(pending), 1_000);
  }

  private async acceptMediaE2eeEnvelope(originPeerId: string, data: Uint8Array): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
    const agentMessage = parseMediaAgentE2eeMessage(raw);
    if (agentMessage) {
      await this.acceptAgentMediaE2eeEnvelope(originPeerId, agentMessage);
      return;
    }
    const message = parseMediaE2eeMessage(raw);
    if (!message || message.membershipEpoch !== this.membershipEpoch() || !this.membershipStable) return;
    if (message.type === "media-key") {
      if (message.senderPeerId !== originPeerId || !this.peers.has(originPeerId) || !this.shouldProtectMedia()) return;
      const key = decodeMediaBaseKey(message);
      const installed = this.mediaE2eeController?.setReceiverKey(
        this.inboundMediaContext(originPeerId, message.publicationId),
        message.keyId,
        key,
      ) === true;
      key.fill(0);
      if (!installed) {
        if (this.mediaE2ee.mode === "required") this.mediaE2eeState.set("unsupported");
        return;
      }
      this.activeReceiverMediaContexts.add(this.inboundMediaContext(originPeerId, message.publicationId));
      await this.sendOverlayData(
        originPeerId,
        new TextEncoder().encode(JSON.stringify(createMediaKeyAck(message))),
        "rekey",
      );
      this.refreshMediaE2eeState();
      return;
    }
    if (message.senderPeerId !== this.ownId) return;
    const contextId = this.outboundMediaContext(message.publicationId, originPeerId);
    const pending = this.pendingMediaKeys.get(contextId);
    if (!pending || pending.message.membershipEpoch !== message.membershipEpoch
      || pending.message.keyId !== message.keyId) return;
    const installed = this.mediaE2eeController?.setSenderKey(
      contextId,
      message.keyId,
      pending.baseKey,
    ) === true;
    if (installed) this.activeSenderMediaContexts.add(contextId);
    this.destroyPendingMediaKey(pending);
    this.pendingMediaKeys.delete(contextId);
    if (installed) this.refreshMediaE2eeState();
    else this.mediaE2eeState.set("unsupported");
  }

  private async acceptAgentMediaE2eeEnvelope(
    originPeerId: string,
    message: ReturnType<typeof parseMediaAgentE2eeMessage> & {},
  ): Promise<void> {
    if (message.membershipEpoch !== this.membershipEpoch() || !this.membershipStable
      || message.routeEpoch !== this.mediaAgents.routeEpoch()
      || message.agentId !== this.mediaAgents.assignedAgentId(message.senderPeerId)) return;
    if (message.type === "media-agent-key") {
      const descriptor = this.descriptors.get(message.publicationId);
      if (message.senderPeerId !== originPeerId || !this.peers.has(originPeerId)
        || descriptor?.rootPeerId !== originPeerId || !this.shouldProtectMedia()) return;
      const key = decodeMediaAgentBaseKey(message);
      const contextId = this.inboundMediaContext(originPeerId, message.publicationId);
      const installed = this.mediaE2eeController?.setReceiverKey(contextId, message.keyId, key) === true;
      key.fill(0);
      if (!installed) {
        if (this.mediaE2ee.mode === "required") this.mediaE2eeState.set("unsupported");
        return;
      }
      this.activeReceiverMediaContexts.add(contextId);
      await this.sendOverlayData(
        originPeerId,
        new TextEncoder().encode(JSON.stringify(createMediaAgentKeyAck(message))),
        "rekey",
      );
      this.refreshMediaE2eeState();
      return;
    }
    if (message.senderPeerId !== this.ownId || originPeerId === this.ownId) return;
    const state = this.agentMediaKeys.get(message.publicationId);
    if (!state || state.agentId !== message.agentId || state.routeEpoch !== message.routeEpoch
      || state.message.keyId !== message.keyId || !this.peers.has(originPeerId)) return;
    state.acknowledgedPeerIds.add(originPeerId);
    this.activateAgentMediaKey(state);
  }

  private rotateMediaKeys(): void {
    if (!this.shouldProtectMedia()) return;
    this.clearAllMediaKeys();
    this.membershipStable = true;
    this.mediaE2eeState.set("pending");
    for (const peer of this.peers.values()) this.provisionMediaKeysForPeer(peer.id);
  }

  private clearPublicationMediaKeys(publication: Publication): void {
    for (const peer of this.peers.values()) {
      const contextId = this.outboundMediaContext(publication.id, peer.id);
      const pending = this.pendingMediaKeys.get(contextId);
      if (pending) this.destroyPendingMediaKey(pending);
      this.pendingMediaKeys.delete(contextId);
      this.activeSenderMediaContexts.delete(contextId);
      this.mediaE2eeController?.clearContext(contextId);
    }
    if (!publication.local) {
      const contextId = this.inboundMediaContext(publication.rootPeerId, publication.id);
      this.activeReceiverMediaContexts.delete(contextId);
      this.mediaE2eeController?.clearContext(contextId);
    }
    this.refreshMediaE2eeState();
  }

  private clearAllMediaKeys(): void {
    this.clearAgentMediaKeys();
    for (const pending of this.pendingMediaKeys.values()) this.destroyPendingMediaKey(pending);
    this.pendingMediaKeys.clear();
    this.activeSenderMediaContexts.clear();
    this.activeReceiverMediaContexts.clear();
    this.mediaE2eeController?.clearKeys();
    if (this.mediaE2ee.mode !== "disabled" && this.mediaE2eeController?.supported) {
      this.mediaE2eeState.set("pending");
    }
  }

  private clearAgentMediaKeys(): void {
    for (const publicationId of [...this.agentMediaKeys.keys()]) this.clearAgentPublicationKey(publicationId);
    this.agentSubscriptionReady.clear();
    this.agentSubscriptionRevisions.clear();
  }

  private clearAgentPublicationKey(publicationId: string): void {
    const state = this.agentMediaKeys.get(publicationId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.baseKey.fill(0);
    this.mediaAgents.deactivatePublication(publicationId);
    this.activeSenderMediaContexts.delete(state.contextId);
    this.mediaE2eeController?.clearContext(state.contextId);
    this.agentMediaKeys.delete(publicationId);
    this.agentSubscriptionReady.delete(publicationId);
  }

  private refreshMediaE2eeState(): void {
    if (this.mediaE2ee.mode === "disabled") {
      this.mediaE2eeState.set("disabled");
    } else if (!this.shouldProtectMedia()) {
      this.mediaE2eeState.set("unsupported");
    } else if (this.pendingMediaKeys.size > 0
      || [...this.agentMediaKeys.values()].some((state) => !state.active)) {
      this.mediaE2eeState.set("pending");
    } else if (this.activeSenderMediaContexts.size > 0 || this.activeReceiverMediaContexts.size > 0) {
      this.mediaE2eeState.set("active");
    } else {
      this.mediaE2eeState.set("pending");
    }
  }

  private destroyPendingMediaKey(pending: PendingMediaKey): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    pending.baseKey.fill(0);
  }
}
