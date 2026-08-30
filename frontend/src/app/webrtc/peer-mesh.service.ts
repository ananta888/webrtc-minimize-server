import { Injectable, computed, signal } from "@angular/core";

import { AudioActivityService } from "./audio-activity.service";
import {
  LinkClass,
  MediaSource,
  OptimizationMode,
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
import { ManagedPeer, PeerConnectionManager } from "./peer-connection-manager";
import { PeerTopologyController } from "./peer-topology-controller";
import { TrustedRelayController } from "./trusted-relay-controller";
import { PeerQualityController } from "./peer-quality-controller";

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
  readonly topologyMode = signal<"adaptive_mesh" | "trusted_peer_relay">("adaptive_mesh");
  readonly topologyEpoch = signal(0);
  readonly membershipEpoch = signal(0);
  readonly routeEpoch = signal(0);
  readonly optimizationMode = signal<OptimizationMode>(
    (sessionStorage.getItem("webrtc-optimization-mode") as OptimizationMode) || "auto",
  );
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
    this.reconcileAllPublications();
  });
  private readonly relay = new TrustedRelayController(this.topology);
  private readonly quality = new PeerQualityController();
  private readonly overlay = new OpaqueDataOverlay();
  private overlayPublicKey: JsonWebKey | null = null;
  private overlayInitialization: Promise<void> = Promise.resolve();
  private overlaySerial = 0;
  private ownId = "";
  private ownName = "";
  private iceServers: readonly RTCIceServer[] = [];
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
  ) {}

  initialize(
    ownId: string,
    ownName: string,
    iceServers: readonly RTCIceServer[],
    optimization?: OptimizationRuntimeConfig,
  ): void {
    this.close();
    this.ownId = ownId;
    this.ownName = ownName;
    this.iceServers = iceServers;
    if (optimization) this.optimization = optimization;
    this.connections = new PeerConnectionManager(ownId, iceServers, this.optimization.dataOverlayEnabled, {
      signal: (to, payload) => this.sendSignal(to, payload),
      track: (peer, track) => this.acceptRemoteTrack(peer as PeerState, track),
      channel: (peer, channel) => this.attachChannel(peer as PeerState, channel),
      state: () => this.updateIceState(),
      negotiationError: (peer) => this.addChat("System", `Verhandlung mit ${peer.name} fehlgeschlagen`, true),
    });
    this.activity.configure(this.optimization.activeSpeakerLimit);
    this.participantNames.set(ownId, ownName);
    this.participantCount.set(1);
    this.startTimers();
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.publishRelayCapability();
    if (this.optimization.dataOverlayEnabled) {
      this.rotateOverlayKey();
    }
  }

  addPeer(peerId: string, name: string): void {
    if (!peerId || peerId === this.ownId || this.peers.has(peerId)) return;
    const peer = this.connections?.add(peerId, name) as PeerState | null;
    if (!peer) return;
    Object.defineProperty(peer, "overlayQueue", { value: new BoundedOverlayQueue(), enumerable: true });
    this.participantNames.set(peerId, peer.name);
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
      return;
    }
    for (const publication of [...this.publications.values()]) {
      if (!publication.local && publication.rootPeerId === rootPeerId && publication.source === source) {
        this.removePublication(publication.id);
      }
    }
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
    if (membershipChanged && this.optimization.dataOverlayEnabled) this.rotateOverlayKey();
    this.topologyMode.set(this.topology.mode(this.ownId));
    this.reconcileAllPublications();
  }

  setOptimizationMode(mode: OptimizationMode): void {
    if (!new Set(["auto", "balanced", "data-saver"]).has(mode)) return;
    this.optimizationMode.set(mode);
    sessionStorage.setItem("webrtc-optimization-mode", mode);
    void this.applyQualityPolicies(true);
  }

  setRelayConsent(enabled: boolean): void {
    if (!this.optimization.peerRelayEnabled || !this.ownId) return;
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
    } catch {
      this.addChat("System", "Ungültiger Overlay-Schlüssel wurde verworfen", true);
    }
  }

  private rotateOverlayKey(): void {
    this.overlayReady.set(false);
    this.overlayPublicKey = null;
    this.overlayInitialization = this.overlay.initialize(this.ownId).then((key) => {
      this.overlayPublicKey = key;
      this.announceOverlayKey();
    }).catch(() => {
      this.overlayMode.set("unavailable");
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
    peer.overlayQueue.clear();
    this.connections?.remove(peerId);
    this.overlay.removePeer(peerId);
    this.updateOverlayAvailability();
    this.participantNames.delete(peerId);
    this.activity.removePeer(peerId);
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
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.connections?.close();
    this.connections = null;
    this.remoteMedia.set([]);
    this.publications.clear();
    this.descriptors.clear();
    this.localStreams.clear();
    this.overlay.destroy();
    this.overlayInitialization = Promise.resolve();
    this.overlayPublicKey = null;
    this.overlayDeliveries.set([]);
    this.overlayMode.set("unavailable");
    this.overlayReady.set(false);
    this.peerChoices.set([]);
    this.participantNames.clear();
    this.activity.close();
    this.ownId = "";
    this.participantCount.set(0);
    this.iceState.set("idle");
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
    if (!this.optimization.peerRelayEnabled || !this.ownId) return;
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

  private acceptRemoteTrack(peer: PeerState, track: MediaStreamTrack): void {
    const descriptor = this.descriptors.get(track.id);
    const publication: Publication = {
      id: track.id,
      rootPeerId: descriptor?.rootPeerId || peer.id,
      rootName: descriptor?.rootName || peer.name,
      source: descriptor?.source || (track.kind === "audio" ? "microphone" : "camera"),
      stream: new MediaStream([track]),
      track,
      local: false,
      inboundPeerId: peer.id,
    };
    const existing = this.publications.get(publication.id);
    if (existing && !existing.local) this.removePublication(existing.id);
    this.publications.set(publication.id, publication);
    this.replaceRemoteView(publication);
    if (track.kind === "audio") this.activity.observe(publication.rootPeerId, track);
    track.onended = () => this.removePublication(publication.id);
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
    for (const peer of this.peers.values()) {
      const sender = peer.senders.get(publicationId);
      if (sender) peer.pc.removeTrack(sender);
      peer.senders.delete(publicationId);
      peer.appliedTiers.delete(publicationId);
    }
    this.publications.delete(publicationId);
    this.descriptors.delete(publicationId);
    this.remoteMedia.update((items) => items.filter((item) => item.key !== publicationId));
    this.activity.remove(publication.track.id);
  }

  private routeChildren(rootPeerId: string, parentPeerId: string): ReadonlySet<string> {
    return this.topology.children(rootPeerId, parentPeerId);
  }

  private shouldSend(publication: Publication, targetPeerId: string): boolean {
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
        try {
          const sender = peer.pc.addTrack(publication.track, publication.stream);
          peer.senders.set(publication.id, sender);
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
      else if (kind === "control") this.sendActivityTo(peer);
      else {
        this.flushOverlayQueue(peer);
        this.updateOverlayAvailability();
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
      else peer.reportedLinkClass = message.linkClass;
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
          const capability = await this.quality.applyAudio(peer, publicationId, sender, this.optimizationMode(), force);
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
        const capability = await this.quality.applyVideo(peer, publicationId, sender, quality, force);
        if (capability) this.qualityCapability.set(capability);
        if (publication.local && (ownQuality === "idle" || publication.source === "screen" || publication.source === "camera")) ownQuality = quality.tier;
      }
    }
    this.localQuality.set(ownQuality);
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
  }
}
