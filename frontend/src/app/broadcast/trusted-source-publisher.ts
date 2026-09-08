import { MediaE2eeController } from "../webrtc/media-e2ee-controller";
import { parseTrustedPackagerKey, sealTrustedDecryptKey, TrustedDecryptKeyEnvelope, TrustedPackagerKeyAnnouncement } from "./trusted-decrypt-key-lifecycle";
import { parseTrustedSourceChannel, parseTrustedSourceLease, parseTrustedSourceSignal, sameTrustedSource, sourceFail,
  sourceWireSize, TrustedSourceLease, TrustedSourceSignal, verifyTrustedSourceAck } from "./trusted-source-contract";

export const TRUSTED_SOURCE_KEY_CHANNEL = "trusted-source-keys-v1";
export interface TrustedSourceEncryption {
  readonly supported: boolean;
  attachSender(sender: RTCRtpSender, context: string): boolean;
  setSenderKey(context: string, keyId: string, baseKey: Uint8Array): boolean;
  destroy(): void;
}
export interface TrustedSourcePublisherPorts {
  /** Owner aborts immediately on local revoke, leave or loss of approval. */
  readonly signal: AbortSignal;
  /** Reads actual local approval and authenticated current membership/lease.
   * A parsed JSON consent alone must never satisfy this port. */
  readonly authorized: (lease: TrustedSourceLease) => boolean;
  /** Bounded, ordered, nonblocking control-plane enqueue; no key material. */
  readonly sendSignal: (message: TrustedSourceSignal) => void;
  readonly onState?: (state: "waiting-key" | "sending" | "stopped" | "failed") => void;
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly createEncryption?: (failure: () => void) => TrustedSourceEncryption;
}
interface PendingKey {
  readonly envelope: TrustedDecryptKeyEnvelope; readonly base: Uint8Array; readonly revision: number;
}

/** One consented source, not room membership or capture authority. The room
 * track is borrowed: stopping this publisher never stops its owner's capture. */
export class TrustedSourcePublisher {
  private pc: RTCPeerConnection | null = null;
  private encryption: TrustedSourceEncryption | null = null;
  private sender: RTCRtpSender | null = null;
  private channel: RTCDataChannel | null = null;
  private closed = false;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private keyTimer: ReturnType<typeof setTimeout> | null = null;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingKey | null = null;
  private preparingBase: Uint8Array | null = null;
  private announcement: TrustedPackagerKeyAnnouncement | null = null;
  private readonly keyIds = new Set<string>();
  private readonly context: string;
  private offerSent = false;
  private answered = false;
  private sequence = 0;
  private incomingSequence = 0;
  private queuedICE: (RTCIceCandidateInit | null)[] = [];
  private chain: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private lastNow = Date.now();
  private deadline = 0;
  private readonly onEnded = () => this.stop();
  private readonly onAbort = () => this.stop();

  private constructor(private lease: TrustedSourceLease, private readonly track: MediaStreamTrack, private readonly ports: TrustedSourcePublisherPorts) {
    this.context = `trusted-source:${lease.sourceLeaseId}`;
    this.armLease();
  }

  static async start(raw: unknown, track: MediaStreamTrack, configuration: RTCConfiguration, ports: TrustedSourcePublisherPorts): Promise<TrustedSourcePublisher> {
    const lease = parseTrustedSourceLease(raw);
    if (!ports || !ports.signal || ports.signal.aborted || typeof ports.signal.addEventListener !== "function" || typeof ports.signal.removeEventListener !== "function"
      || typeof ports.authorized !== "function" || typeof ports.sendSignal !== "function"
      || !ports.authorized(lease) || !track || track.readyState !== "live" || track.id !== lease.publicationId
      || track.kind !== (lease.codec === "audio/opus" ? "audio" : "video") || lease.revision !== 1) return sourceFail();
    const publisher = new TrustedSourcePublisher(lease, track, ports);
    try { await publisher.open(configuration); return publisher; }
    catch { publisher.stop(true); return sourceFail(); }
  }

  private async open(configuration: RTCConfiguration): Promise<void> {
    this.assertCurrent();
    this.ports.signal.addEventListener("abort", this.onAbort, {once:true});
    this.encryption = this.ports.createEncryption?.(() => this.stop(true)) ?? new MediaE2eeController(() => this.stop(true), () => this.stop(true));
    if (!this.encryption.supported) sourceFail();
    this.pc = this.ports.createPeerConnection?.(configuration) ?? new RTCPeerConnection(configuration);
    this.track.addEventListener("ended", this.onEnded);
    const transceiver = this.pc.addTransceiver(this.track, { direction: "sendonly", sendEncodings: [{ active: false }], streams: [new MediaStream([this.track])] });
    this.sender = transceiver.sender;
    const codecs = RTCRtpSender.getCapabilities(this.track.kind)?.codecs.filter(codec => codec.mimeType.toLowerCase() === this.lease.codec);
    if (!codecs?.length || !this.encryption.attachSender(this.sender, this.context)) sourceFail();
    transceiver.setCodecPreferences(codecs);
    this.channel = this.pc.createDataChannel(TRUSTED_SOURCE_KEY_CHANNEL, { ordered: true, protocol: TRUSTED_SOURCE_KEY_CHANNEL });
    this.channel.onmessage = event => {
      try {
        const value = parseTrustedSourceChannel(event.data);
        void this.enqueue(() => this.keyMessage(value));
      } catch { this.stop(true); }
    };
    this.channel.onclose = () => this.stop(true);
    this.channel.onerror = () => this.stop(true);
    this.pc.ondatachannel = () => this.stop(true); // Native endpoint may not create extra channels.
    this.pc.ontrack = () => this.stop(true); // This connection never grants media subscriptions.
    this.pc.onconnectionstatechange = () => {
      if (this.pc && ["failed", "closed", "disconnected"].includes(this.pc.connectionState)) this.stop(true);
    };
    this.pc.onicecandidate = event => {
      if (this.closed) return;
      try {
        const candidate = event.candidate?.toJSON() ?? null;
        if (!this.offerSent) {
          if (this.queuedICE.length >= 128) sourceFail();
          this.queuedICE.push(candidate);
        } else this.send({ candidate });
      } catch { this.stop(true); }
    };
    this.startupTimer = setTimeout(() => this.stop(true), 5000);
    this.ports.onState?.("waiting-key");
    const offer = await this.pc.createOffer();
    this.assertCurrent();
    await this.pc!.setLocalDescription(offer);
    this.assertCurrent();
    this.send({ description: { type: "offer", sdp: offer.sdp } });
    this.offerSent = true;
    for (const candidate of this.queuedICE) this.send({ candidate });
    this.queuedICE = [];
  }

  receiveSignal(raw: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    let message: TrustedSourceSignal;
    try { message = parseTrustedSourceSignal(raw, this.lease); }
    catch { this.stop(true); return Promise.resolve(); }
    return this.enqueue(async () => {
      this.assertCurrent();
      if (message.negotiationRevision !== 1 || message.sequence !== this.incomingSequence+1
        || !this.offerSent || (message.description ? this.answered : !this.answered)) sourceFail();
      this.incomingSequence = message.sequence;
      if (message.description) { await this.pc!.setRemoteDescription(message.description); this.assertCurrent(); this.answered = true; }
      else { await this.pc!.addIceCandidate(message.candidate ?? undefined); this.assertCurrent(); }
    });
  }

  renew(raw: unknown): void {
    try {
      this.assertCurrent();
      const next = parseTrustedSourceLease(raw);
      if (!sameTrustedSource(this.lease, next) || !this.ports.authorized(next)) sourceFail();
      if (next.revision === this.lease.revision && next.issuedAt === this.lease.issuedAt && next.expiresAt === this.lease.expiresAt) return;
      if (next.revision !== this.lease.revision+1 || next.issuedAt < this.lease.issuedAt || next.expiresAt <= this.lease.expiresAt) sourceFail();
      this.lease = next; this.armLease();
    } catch { this.stop(true); }
  }

  stop(failed = false): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.leaseTimer, this.keyTimer, this.rotationTimer, this.ackTimer, this.startupTimer]) if (timer !== null) clearTimeout(timer);
    this.leaseTimer = this.keyTimer = this.rotationTimer = this.ackTimer = this.startupTimer = null;
    this.track.removeEventListener("ended", this.onEnded);
    this.ports.signal.removeEventListener("abort", this.onAbort);
    this.preparingBase?.fill(0); this.preparingBase = null;
    this.pending?.base.fill(0); this.pending = null; this.announcement = null; this.queuedICE = []; this.keyIds.clear();
    if (this.channel) { this.channel.onmessage = this.channel.onclose = this.channel.onerror = null; this.channel.close(); }
    this.channel = null;
    if (this.pc) {
      this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = this.pc.ontrack = null;
      this.pc.close();
    }
    this.pc = null; this.sender = null;
    this.encryption?.destroy(); this.encryption = null;
    this.ports.onState?.(failed ? "failed" : "stopped");
  }

  private armLease(): void {
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    const remaining = this.lease.expiresAt-Date.now();
    this.deadline = performance.now()+remaining;
    this.leaseTimer = setTimeout(() => this.stop(true), Math.max(0, remaining));
  }
  private assertCurrent(): void {
    const now = Date.now();
    if (this.closed || this.ports.signal.aborted || now < this.lastNow || now >= this.lease.expiresAt || performance.now() >= this.deadline
      || this.track.readyState !== "live" || !this.ports.authorized(this.lease)) { this.stop(true); sourceFail(); }
    this.lastNow = now;
  }
  private send(payload: Pick<TrustedSourceSignal, "description" | "candidate">): void {
    this.assertCurrent();
    this.ports.sendSignal(parseTrustedSourceSignal({ version: 1, type: "trusted-source-publisher-signal", sourceLeaseId: this.lease.sourceLeaseId,
      consentId: this.lease.consent.consentId, assignmentId: this.lease.assignmentId, fencingRevision: this.lease.fencingRevision,
      negotiationRevision: 1, sequence: ++this.sequence, ...payload }, this.lease, false));
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (++this.queuedOperations > 32) { this.stop(true); return Promise.resolve(); }
    this.chain = this.chain.then(async () => { if (!this.closed) await operation(); }).catch(() => this.stop(true))
      .finally(() => { this.queuedOperations--; });
    return this.chain;
  }

  private async keyMessage(value: unknown): Promise<void> {
    this.assertCurrent();
    if (!this.answered) sourceFail();
    if (!this.announcement) {
      this.announcement = parseTrustedPackagerKey(value, this.lease.consent);
      await this.rotateKey(); return;
    }
    const pending = this.pending;
    if (!pending) sourceFail();
    verifyTrustedSourceAck(value, this.lease, pending.envelope, pending.revision);
    // Bound installed keys even if setParameters never resolves. The existing
    // ACK/startup timers also remain armed until activation has completed.
    if (this.keyTimer !== null) clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(() => this.stop(true), Math.max(0, pending.envelope.expiresAt-Date.now()));
    if (!this.encryption!.setSenderKey(this.context, pending.envelope.keyId, pending.base)) sourceFail();
    pending.base.fill(0); this.pending = null;
    const parameters = this.sender!.getParameters();
    if (parameters.encodings.length !== 1) sourceFail();
    parameters.encodings[0].active = true;
    await this.sender!.setParameters(parameters);
    this.assertCurrent();
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.ackTimer = this.startupTimer = null;
    if (pending.envelope.expiresAt < Math.min(this.lease.consent.expiresAt, this.announcement.expiresAt)
      && pending.envelope.expiresAt-Date.now() > 2000) {
      this.rotationTimer = setTimeout(() => { void this.enqueue(() => this.rotateKey()); }, Math.max(1000, pending.envelope.expiresAt-Date.now()-15000));
    }
    this.ports.onState?.("sending"); // Configured sender, not a decode/output acknowledgement.
  }

  private async rotateKey(): Promise<void> {
    this.assertCurrent();
    if (this.pending || !this.announcement || this.keyIds.size >= 512) sourceFail();
    const keyId = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (this.keyIds.has(keyId)) sourceFail();
    this.keyIds.add(keyId);
    const base = crypto.getRandomValues(new Uint8Array(16));
    this.preparingBase = base;
    let retained = false;
    try {
      const envelope = await sealTrustedDecryptKey({ consent: this.lease.consent, announcement: this.announcement, keyId, baseKey: base });
      this.assertCurrent();
      if (!this.channel || this.channel.readyState !== "open" || this.channel.bufferedAmount > 16384 || !sourceWireSize(envelope, 8192)) sourceFail();
      this.pending = { envelope, base, revision: this.lease.revision }; retained = true;
      this.channel.send(JSON.stringify(envelope));
      this.ackTimer = setTimeout(() => this.stop(true), 3000);
    } finally {
      if (this.preparingBase === base) this.preparingBase = null;
      if (!retained) base.fill(0);
    }
  }
}
