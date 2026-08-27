import { Injectable, signal } from "@angular/core";

import { ServerMessage, SignalingService } from "./signaling.service";

type MediaSource = "microphone" | "camera" | "screen" | "screen-audio";

interface PeerState {
  readonly id: string;
  readonly name: string;
  readonly pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  readonly polite: boolean;
}

export interface RemoteMediaView {
  readonly key: string;
  readonly peerId: string;
  readonly peerName: string;
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

@Injectable({ providedIn: "root" })
export class PeerMeshService {
  readonly remoteMedia = signal<readonly RemoteMediaView[]>([]);
  readonly participantCount = signal(0);
  readonly chat = signal<readonly ChatEntry[]>([]);
  readonly iceState = signal("idle");
  private readonly peers = new Map<string, PeerState>();
  private readonly localPublications = new Map<MediaSource, MediaStream>();
  private readonly remoteSources = new Map<string, Map<string, MediaSource>>();
  private ownId = "";
  private ownName = "";
  private iceServers: readonly RTCIceServer[] = [];
  private chatSerial = 0;

  constructor(private readonly signaling: SignalingService) {}

  initialize(ownId: string, ownName: string, iceServers: readonly RTCIceServer[]): void {
    this.close();
    this.ownId = ownId;
    this.ownName = ownName;
    this.iceServers = iceServers;
    this.participantCount.set(1);
  }

  addPeer(peerId: string, name: string): void {
    if (!peerId || peerId === this.ownId || this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: [...this.iceServers] });
    const peer: PeerState = {
      id: peerId,
      name: name || "Peer",
      pc,
      channel: null,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      polite: this.ownId > peerId,
    };
    this.peers.set(peerId, peer);
    for (const stream of this.localPublications.values()) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
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
    if (this.ownId < peerId) this.attachChannel(peer, pc.createDataChannel("chat", { ordered: true }));
    this.participantCount.set(this.peers.size + 1);
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
    this.localPublications.set(source, stream);
    for (const peer of this.peers.values()) {
      for (const track of stream.getTracks()) peer.pc.addTrack(track, stream);
    }
    for (const track of stream.getTracks()) {
      const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
      this.signaling.send({ type: "media-state", source: trackSource, active: true, trackId: track.id });
    }
  }

  detachPublication(source: MediaSource): void {
    const stream = this.localPublications.get(source);
    if (!stream) return;
    const tracks = stream.getTracks();
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) peer.pc.removeTrack(sender);
      }
    }
    for (const track of tracks) {
      const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
      try { this.signaling.send({ type: "media-state", source: trackSource, active: false }); } catch { /* disconnected */ }
    }
    this.localPublications.delete(source);
  }

  announcePublications(): void {
    for (const [source, stream] of this.localPublications) {
      for (const track of stream.getTracks()) {
        const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
        this.signaling.send({ type: "media-state", source: trackSource, active: true, trackId: track.id });
      }
    }
  }

  updateRemoteSource(message: ServerMessage): void {
    const peerId = String(message["from"] || "");
    const source = String(message["source"] || "") as MediaSource;
    const sources = this.remoteSources.get(peerId) || new Map<string, MediaSource>();
    if (message["active"] === true) sources.set(String(message["trackId"] || ""), source);
    else for (const [trackId, current] of sources) if (current === source) sources.delete(trackId);
    this.remoteSources.set(peerId, sources);
    this.remoteMedia.update((items) => items.map((item) => item.peerId === peerId
      ? { ...item, source: sources.get(item.stream.getTracks()[0]?.id || "") || item.source }
      : item));
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.channel?.close();
    peer.pc.close();
    this.peers.delete(peerId);
    this.remoteSources.delete(peerId);
    this.remoteMedia.update((items) => items.filter((item) => item.peerId !== peerId));
    this.participantCount.set(this.peers.size + (this.ownId ? 1 : 0));
    this.updateIceState();
  }

  sendChat(text: string): void {
    const value = text.trim();
    if (!value || value.length > 2_000) return;
    const payload = JSON.stringify({ version: 1, type: "chat", text: value });
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === "open" && peer.channel.bufferedAmount < 256_000) peer.channel.send(payload);
    }
    this.addChat(this.ownName || "Du", value, false);
  }

  close(): void {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.remoteMedia.set([]);
    this.remoteSources.clear();
    this.ownId = "";
    this.participantCount.set(0);
    this.iceState.set("idle");
  }

  private sendSignal(to: string, payload: object): void {
    this.signaling.send({ type: "signal", to, ...payload });
  }

  private acceptRemoteTrack(peer: PeerState, track: MediaStreamTrack): void {
    const stream = new MediaStream([track]);
    const source = this.remoteSources.get(peer.id)?.get(track.id)
      || (track.kind === "audio" ? "microphone" : "camera");
    const entry: RemoteMediaView = {
      key: `${peer.id}:${track.id}`,
      peerId: peer.id,
      peerName: peer.name,
      source,
      stream,
      kind: track.kind as "audio" | "video",
    };
    this.remoteMedia.update((items) => [...items.filter((item) => item.key !== entry.key), entry]);
    track.onended = () => this.remoteMedia.update((items) => items.filter((item) => item.key !== entry.key));
  }

  private attachChannel(peer: PeerState, channel: RTCDataChannel): void {
    peer.channel?.close();
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.addChat("System", `${peer.name}: Peer-Chat verbunden`, true);
    channel.onmessage = ({ data }) => {
      if (typeof data !== "string" || data.length > 8_192) return;
      try {
        const value = JSON.parse(data) as { version?: number; type?: string; text?: unknown };
        if (value.version !== 1 || value.type !== "chat" || typeof value.text !== "string" || value.text.length > 2_000) return;
        this.addChat(peer.name, value.text, false);
      } catch { /* invalid DataChannel payload */ }
    };
  }

  private addChat(author: string, text: string, system: boolean): void {
    this.chat.update((entries) => [...entries.slice(-199), {
      id: ++this.chatSerial, author, text, system,
    }]);
  }

  private updateIceState(): void {
    const states = [...this.peers.values()].map((peer) => peer.pc.iceConnectionState);
    if (states.length === 0) this.iceState.set("idle");
    else if (states.some((state) => state === "failed")) this.iceState.set("failed");
    else if (states.some((state) => state === "connected" || state === "completed")) this.iceState.set("connected");
    else this.iceState.set(states[0] || "new");
  }
}
