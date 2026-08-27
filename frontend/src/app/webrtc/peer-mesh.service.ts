import { Injectable, computed, signal } from "@angular/core";

import { AudioActivityService } from "./audio-activity.service";
import {
  LinkClass,
  MediaSource,
  OptimizationMode,
  QualitySettings,
  VideoTier,
  classifyLinkStats,
  selectVideoQuality,
  stabilizeLinkClass,
} from "./media-optimization-policy";
import {
  CHAT_BUFFER_LIMIT,
  CONTROL_BUFFER_LIMIT,
  parsePeerChat,
  parsePeerControl,
} from "./peer-control-protocol";
import { ServerMessage, SignalingService } from "./signaling.service";
import { validateTopologyState } from "./topology-contract";

interface PeerState {
  readonly id: string;
  readonly name: string;
  readonly pc: RTCPeerConnection;
  readonly channels: Map<"chat" | "control", RTCDataChannel>;
  readonly senders: Map<string, RTCRtpSender>;
  readonly appliedTiers: Map<string, string>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  readonly polite: boolean;
  linkClass: LinkClass;
  reportedLinkClass: LinkClass;
  lastControlSequence: number;
  linkCandidate: LinkClass;
  linkCandidateSince: number;
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

interface TopologyRoute {
  readonly rootPeerId: string;
  readonly mode: "adaptive_mesh" | "trusted_peer_relay";
  readonly children: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface OptimizationRuntimeConfig {
  readonly activeSpeakerLimit: number;
  readonly peerRelayEnabled: boolean;
  readonly peerRelayMinParticipants: number;
  readonly peerRelayMaxChildren: number;
  readonly peerRelayMaxHops: number;
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
  readonly iceState = signal("idle");
  readonly topologyMode = signal<"adaptive_mesh" | "trusted_peer_relay">("adaptive_mesh");
  readonly topologyEpoch = signal(0);
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
  private readonly peers = new Map<string, PeerState>();
  private readonly participantNames = new Map<string, string>();
  private readonly localStreams = new Map<string, MediaStream>();
  private readonly publications = new Map<string, Publication>();
  private readonly descriptors = new Map<string, Pick<Publication, "rootPeerId" | "rootName" | "source">>();
  private readonly routes = new Map<string, TopologyRoute>();
  private ownId = "";
  private ownName = "";
  private iceServers: readonly RTCIceServer[] = [];
  private optimization: OptimizationRuntimeConfig = {
    activeSpeakerLimit: 5,
    peerRelayEnabled: false,
    peerRelayMinParticipants: 6,
    peerRelayMaxChildren: 3,
    peerRelayMaxHops: 3,
  };
  private chatSerial = 0;
  private controlSequence = 0;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;

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
    this.activity.configure(this.optimization.activeSpeakerLimit);
    this.participantNames.set(ownId, ownName);
    this.participantCount.set(1);
    this.startTimers();
  }

  addPeer(peerId: string, name: string): void {
    if (!peerId || peerId === this.ownId || this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: [...this.iceServers] });
    const peer: PeerState = {
      id: peerId,
      name: name || "Peer",
      pc,
      channels: new Map(),
      senders: new Map(),
      appliedTiers: new Map(),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      polite: this.ownId > peerId,
      linkClass: "unknown",
      reportedLinkClass: "unknown",
      lastControlSequence: -1,
      linkCandidate: "unknown",
      linkCandidateSince: Date.now(),
    };
    this.peers.set(peerId, peer);
    this.participantNames.set(peerId, peer.name);
    pc.onicecandidate = ({ candidate }) => this.sendSignal(peerId, { candidate });
    pc.ontrack = ({ track }) => this.acceptRemoteTrack(peer, track);
    pc.ondatachannel = ({ channel }) => this.attachChannel(peer, channel);
    pc.oniceconnectionstatechange = () => this.updateIceState();
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
      this.updateIceState();
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignal(peerId, { description: pc.localDescription });
      } catch {
        this.addChat("System", `Verhandlung mit ${peer.name} fehlgeschlagen`, true);
      } finally {
        peer.makingOffer = false;
      }
    };
    if (this.ownId < peerId) {
      this.attachChannel(peer, pc.createDataChannel("control", { ordered: true }));
      this.attachChannel(peer, pc.createDataChannel("chat", { ordered: true }));
    }
    this.participantCount.set(this.peers.size + 1);
    this.reconcileAllPublications();
  }

  async acceptSignal(message: ServerMessage): Promise<void> {
    const from = String(message["from"] || "");
    this.addPeer(from, String(message["fromName"] || "Peer"));
    const peer = this.peers.get(from);
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
          this.sendSignal(peer.id, { description: peer.pc.localDescription });
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
      this.addChat("System", `WebRTC-Signal von ${peer.name} abgelehnt`, true);
    }
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
    const state = validateTopologyState(
      message,
      [this.ownId, ...this.peers.keys()],
      this.topologyEpoch(),
      {
        maxChildren: this.optimization.peerRelayMaxChildren,
        maxHops: this.optimization.peerRelayMaxHops,
      },
    );
    if (!state) return;
    const nextRoutes = new Map<string, TopologyRoute>();
    for (const route of state.routes) {
      const mutableChildren = new Map<string, Set<string>>();
      for (const edge of route.edges) {
        const children = mutableChildren.get(edge.parentPeerId) || new Set<string>();
        children.add(edge.childPeerId);
        mutableChildren.set(edge.parentPeerId, children);
      }
      nextRoutes.set(route.rootPeerId, {
        rootPeerId: route.rootPeerId,
        mode: route.mode,
        children: new Map([...mutableChildren].map(([parent, children]) => [parent, new Set(children)])),
      });
    }
    this.routes.clear();
    for (const [root, route] of nextRoutes) this.routes.set(root, route);
    this.topologyEpoch.set(state.epoch);
    this.topologyMode.set(this.routes.get(this.ownId)?.mode || "adaptive_mesh");
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

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const channel of peer.channels.values()) channel.close();
    peer.pc.close();
    this.peers.delete(peerId);
    this.participantNames.delete(peerId);
    this.activity.removePeer(peerId);
    for (const publication of [...this.publications.values()]) {
      if (!publication.local && publication.inboundPeerId === peerId) this.removePublication(publication.id);
    }
    this.remoteMedia.update((items) => items.filter((item) => item.transportPeerId !== peerId));
    this.participantCount.set(this.peers.size + (this.ownId ? 1 : 0));
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
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.remoteMedia.set([]);
    this.publications.clear();
    this.descriptors.clear();
    this.localStreams.clear();
    this.routes.clear();
    this.participantNames.clear();
    this.activity.close();
    this.ownId = "";
    this.participantCount.set(0);
    this.iceState.set("idle");
    this.topologyMode.set("adaptive_mesh");
    this.topologyEpoch.set(0);
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
    return this.routes.get(rootPeerId)?.children.get(parentPeerId) || new Set<string>();
  }

  private shouldSend(publication: Publication, targetPeerId: string): boolean {
    if (publication.track.kind === "audio") return publication.local;
    const route = this.routes.get(publication.rootPeerId);
    if (!route || route.mode === "adaptive_mesh") return publication.local;
    return this.routeChildren(publication.rootPeerId, this.ownId).has(targetPeerId);
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

  private attachChannel(peer: PeerState, channel: RTCDataChannel): void {
    if (channel.label !== "chat" && channel.label !== "control") {
      channel.close();
      return;
    }
    const kind = channel.label;
    peer.channels.get(kind)?.close();
    peer.channels.set(kind, channel);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = kind === "control" ? CONTROL_BUFFER_LIMIT / 2 : CHAT_BUFFER_LIMIT / 2;
    channel.onopen = () => {
      if (kind === "chat") this.addChat("System", `${peer.name}: Peer-Chat verbunden`, true);
      else this.sendActivityTo(peer);
    };
    channel.onmessage = ({ data }) => {
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
        const reports = await peer.pc.getStats();
        let availableOutgoingBitrate: number | undefined;
        let roundTripTime: number | undefined;
        let lossRatio: number | undefined;
        reports.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) {
            if (Number.isFinite(report.availableOutgoingBitrate)) availableOutgoingBitrate = report.availableOutgoingBitrate;
            if (Number.isFinite(report.currentRoundTripTime)) roundTripTime = report.currentRoundTripTime;
          }
          if (report.type === "remote-inbound-rtp" && Number.isFinite(report.fractionLost)) {
            lossRatio = Math.max(lossRatio || 0, report.fractionLost);
          }
        });
        const candidate = classifyLinkStats({ availableOutgoingBitrate, roundTripTime, lossRatio });
        const now = Date.now();
        if (candidate !== peer.linkCandidate) {
          peer.linkCandidate = candidate;
          peer.linkCandidateSince = now;
        }
        const stable = stabilizeLinkClass({
          current: peer.linkClass,
          candidate,
          candidateSince: peer.linkCandidateSince,
          now,
        });
        peer.linkClass = stable.value;
        peer.linkCandidateSince = stable.candidateSince;
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
          await this.applyAudioParameters(peer, publicationId, sender, force);
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
        await this.applyVideoParameters(peer, publicationId, sender, quality, force);
        if (publication.local && (ownQuality === "idle" || publication.source === "screen" || publication.source === "camera")) ownQuality = quality.tier;
      }
    }
    this.localQuality.set(ownQuality);
  }

  private async applyAudioParameters(peer: PeerState, publicationId: string, sender: RTCRtpSender, force: boolean): Promise<void> {
    const signature = `audio:${this.optimizationMode()}`;
    if (!force && peer.appliedTiers.get(publicationId) === signature) return;
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return;
    parameters.encodings[0].active = true;
    parameters.encodings[0].maxBitrate = this.optimizationMode() === "data-saver" ? 20_000 : 32_000;
    try {
      await sender.setParameters(parameters);
      peer.appliedTiers.set(publicationId, signature);
      this.qualityCapability.set("available");
    } catch {
      this.qualityCapability.set("degraded");
    }
  }

  private async applyVideoParameters(peer: PeerState, publicationId: string, sender: RTCRtpSender, quality: QualitySettings, force: boolean): Promise<void> {
    const signature = `${quality.tier}:${quality.maxBitrate}:${quality.maxFramerate}:${quality.scaleResolutionDownBy}`;
    if (!force && peer.appliedTiers.get(publicationId) === signature) return;
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) {
      this.qualityCapability.set("degraded");
      return;
    }
    parameters.degradationPreference = quality.tier === "screen" ? "maintain-resolution" : "balanced";
    parameters.encodings[0].active = quality.active;
    parameters.encodings[0].maxBitrate = Math.max(1, quality.maxBitrate);
    parameters.encodings[0].maxFramerate = quality.maxFramerate;
    parameters.encodings[0].scaleResolutionDownBy = quality.scaleResolutionDownBy;
    try {
      await sender.setParameters(parameters);
      peer.appliedTiers.set(publicationId, signature);
      this.qualityCapability.set("available");
    } catch {
      this.qualityCapability.set("degraded");
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
  }
}
