import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineAudioGraph, MachineAudioGraphFactory } from "./machine-audio-graph";
import { wipeMachinePcm } from "./machine-pcm-buffer";

interface AudioChunk { readonly sequence: number; readonly startSample: number; readonly pcm: ArrayBuffer }

@Injectable()
export class MachineAudioSessionService implements OnDestroy {
  private graph: MachineAudioGraph | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: AudioChunk[] = [];
  private binding = "";
  private source: ReturnType<PeerMeshService["machineAudioSource"]> | null = null;
  private publicationId = "";
  private serial = 0; private delivered = 0; private acknowledged = 0; private maxChunks = 100;
  private deadline = 0; private completed = false; private error = "";
  private lastNow = 0;
  private subscriptionId = ""; private replied = false;
  private finishedSample: number | null = null;
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService,
    private readonly graphs: MachineAudioGraphFactory) {}
  supported(): boolean { return this.graphs.supported(); }
  segmentProbe() {
    return Object.freeze({ schema: "ananta.meet-audio-segment-probe.v1", profile: "sample-boundary-v1", supported: this.supported() });
  }
  sources() {
    if (!this.session.joined() || !this.session.machineContext()) return Object.freeze([]);
    return Object.freeze(this.mesh.remoteMedia().flatMap(view => {
      try {
        const source = this.mesh.machineAudioSource(view.key);
        return [Object.freeze({ publicationId: view.key, peerId: source.peerId, source: source.source })];
      } catch { return []; }
    }));
  }
  async open(publicationId: string, seconds = 10) {
    this.close(); this.error = "";
    if (typeof publicationId !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(publicationId)
      || !Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw new Error("meet_audio_request_invalid");
    this.publicationId = publicationId; this.maxChunks = seconds * 10;
    this.subscriptionId = crypto.randomUUID().replaceAll("-", ""); this.replied = false;
    const controller = new AbortController(); this.controller = controller;
    this.lastNow = Date.now();
    try {
      this.source = this.mesh.machineAudioSource(publicationId);
      const binding = this.currentBinding(); this.binding = JSON.stringify(binding);
      this.deadline = Math.min(Date.now() + 30_000, binding.deadline_ms);
      this.timer = setInterval(() => { try { this.check(); } catch { /* Already stopped. */ } }, 100);
      const setup = setTimeout(() => { if (this.controller === controller && !this.graph) this.stop("meet_audio_setup_timeout"); }, 5000);
      try {
        const graph = await this.graphs.connect(this.source.track, (start, pcm) => {
          if (this.controller !== controller) { wipeMachinePcm(pcm); return; }
          this.accept(start, pcm);
        },
          () => { if (this.controller === controller) this.stop("meet_audio_decoder_failed"); }, controller.signal);
        if (this.controller !== controller || controller.signal.aborted) { await graph.close(); throw new Error("meet_audio_cancelled"); }
        this.graph = graph; this.check();
      } finally { clearTimeout(setup); }
      return Object.freeze({ schema: "ananta.meet-audio-subscription.draft1", binding,
        subscriptionId: this.subscriptionId, format: "pcm_s16le", sampleRate: 16000, channels: 1, chunkSamples: 1600, maxSeconds: seconds });
    } catch (error) {
      if (this.controller === controller) this.stop("meet_audio_open_failed");
      throw new Error(error instanceof Error && /^meet_audio_[a-z_]+$/.test(error.message) ? error.message : "meet_audio_open_failed");
    }
  }
  private currentBinding() {
    const context = this.session.machineContext(), lease = this.session.machineLease(), own = this.mesh.ownPeerId();
    if (!context || !lease || !this.session.joined() || lease.expiresAt <= Date.now()) throw new Error("meet_audio_lease_denied");
    const source = this.mesh.machineAudioSource(this.publicationId);
    if (source.track !== this.source?.track) throw new Error("meet_audio_source_changed");
    const grant = this.mesh.machineReceive.grants().find(g => g.machinePeerId === own && g.publisherPeerId === source.peerId
      && g.publicationIds.includes(this.publicationId) && g.expiresAt > Date.now());
    const membershipEpoch = this.mesh.membershipEpoch(), revision = this.mesh.machineReceive.revision();
    if (!grant || membershipEpoch < 1 || revision < 1) throw new Error("meet_audio_source_denied");
    return Object.freeze({ tenant_id: context.tenantId, project_id: context.projectId, task_id: context.taskId,
      lease_id: lease.sessionId, runtime_id: context.runtimeId, session_id: context.hubSessionId,
      generation: lease.generation, room_id: this.session.roomId(), membership_epoch: membershipEpoch,
      peer_id: source.peerId, own_peer_id: own, publication_id: this.publicationId,
      receive_revision: revision, source: source.source === "screen-audio" ? "screen_audio" : "microphone",
      deadline_ms: Math.min(lease.expiresAt, grant.expiresAt) });
  }
  private check(): void {
    try {
      const now = Date.now();
      if (!this.controller || this.controller.signal.aborted || now < this.lastNow || now >= this.deadline
        || JSON.stringify(this.currentBinding()) !== this.binding) throw new Error("meet_audio_binding_changed");
      this.lastNow = now;
    } catch { this.stop("meet_audio_binding_changed"); throw new Error("meet_audio_binding_changed"); }
  }
  private accept(startSample: number, pcm: ArrayBuffer): void {
    let retained = false;
    try {
      this.check();
      if (this.completed) return;
      if (!(pcm instanceof ArrayBuffer) || pcm.byteLength !== 3200 || startSample !== this.serial * 1600 || this.queue.length >= 10) {
        this.stop("meet_audio_queue_or_timeline_invalid"); throw new Error("meet_audio_queue_or_timeline_invalid");
      }
      this.queue.push({ sequence: ++this.serial, startSample, pcm }); retained = true;
      if (this.serial >= this.maxChunks) { this.completed = true; void this.graph?.close(); this.graph = null; }
    } finally {
      if (!retained) wipeMachinePcm(pcm);
    }
  }
  poll() {
    this.check();
    const chunks = this.queue.slice(0, 5).map(chunk => Object.freeze({ sequence: chunk.sequence,
      startSample: chunk.startSample, pcmBase64: btoa(String.fromCharCode(...new Uint8Array(chunk.pcm))) }));
    if (chunks.length) this.delivered = Math.max(this.delivered, chunks[chunks.length - 1].sequence);
    return Object.freeze({ schema: "ananta.meet-audio-batch.draft1", completed: this.completed,
      acknowledged: this.acknowledged, chunks: Object.freeze(chunks) });
  }
  ack(sequence: number): void {
    this.check();
    if (!Number.isSafeInteger(sequence) || sequence < this.acknowledged || sequence > this.delivered) throw new Error("meet_audio_ack_invalid");
    this.acknowledged = sequence;
    while (this.queue.length && this.queue[0].sequence <= sequence) wipeMachinePcm(this.queue.shift()!.pcm);
  }
  status() { return Object.freeze({ open: Boolean(this.controller), completed: this.completed, error: this.error }); }
  finish(subscriptionId: string, endSample: number) {
    this.check();
    if (typeof subscriptionId !== "string" || subscriptionId !== this.subscriptionId || this.replied
      || !Number.isSafeInteger(endSample) || endSample < 16000 || endSample > this.maxChunks * 1600
      || endSample % 1600 !== 0 || endSample !== this.acknowledged * 1600
      || this.finishedSample !== null && this.finishedSample !== endSample) throw new Error("meet_audio_finish_denied");
    if (this.finishedSample === null) {
      this.finishedSample = endSample; this.completed = true;
      for (const chunk of this.queue) wipeMachinePcm(chunk.pcm); this.queue = [];
      this.delivered = this.acknowledged;
      const graph = this.graph, controller = this.controller; this.graph = null;
      const failed = () => {
        // Cleanup belongs to the finished subscription, never its replacement.
        if (this.controller === controller) this.stop("meet_audio_finish_failed");
      };
      try { void graph?.close().catch(failed); }
      catch { failed(); throw new Error("meet_audio_finish_failed"); }
    }
    return Object.freeze({ schema: "ananta.meet-audio-segment-finished.v1", subscriptionId, endSample });
  }
  reply(subscriptionId: string, text: string) {
    this.check();
    if (!this.completed || subscriptionId !== this.subscriptionId || this.replied
      || !this.mesh.machineReceive.supports(this.mesh.ownPeerId(), "chat.send") || typeof text !== "string"
      || !text.trim() || [...text].length > 450) throw new Error("meet_audio_reply_denied");
    this.replied = true; // At most once, even when delivery is uncertain.
    return this.mesh.sendMachineChatReply(text, subscriptionId);
  }
  private stop(code: string): void { this.error = code; this.close(); }
  close(): void {
    this.controller?.abort(); this.controller = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    void this.graph?.close(); this.graph = null;
    for (const chunk of this.queue) wipeMachinePcm(chunk.pcm); this.queue = [];
    this.source = null; this.binding = ""; this.publicationId = "";
    this.subscriptionId = ""; this.replied = false;
    this.finishedSample = null;
    this.serial = this.delivered = this.acknowledged = 0; this.completed = false;
  }
  ngOnDestroy(): void { this.close(); }
}
