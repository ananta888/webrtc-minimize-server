import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineVisualSurface, MachineVisualSurfaceFactory, VISUAL_LIMITS, VisualPixels } from "./machine-visual-surface";
import { visualOperation } from "./machine-visual-operation";

/** Source/lease authority and bounded export, independent from pixel decoding. */
@Injectable()
export class MachineVisualSessionService implements OnDestroy {
  private controller: AbortController | null = null;
  private surface: MachineVisualSurface | null = null;
  private source: ReturnType<PeerMeshService["machineVisualSource"]> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private publicationId = ""; private subscriptionId = ""; private binding = "";
  private deadline = 0; private lastNow = 0; private lastFrame = -Infinity;
  private sequence = 0; private busy = false; private error = "";
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService,
    private readonly surfaces: MachineVisualSurfaceFactory) {}
  probe() {
    return Object.freeze({ schema: "ananta.meet-visual-probe.v1", profile: "jpeg-source-v1",
      supported: this.surfaces.supported(), limits: VISUAL_LIMITS });
  }
  sources() {
    if (!this.session.joined() || !this.session.machineContext()) return Object.freeze([]);
    return Object.freeze(this.mesh.remoteMedia().flatMap(view => {
      try {
        const source = this.mesh.machineVisualSource(view.key);
        return [Object.freeze({ publicationId: view.key, peerId: source.peerId, source: source.source,
          publicationEpoch: source.publicationEpoch })];
      } catch { return []; }
    }));
  }
  async open(publicationId: string) {
    this.close(); this.error = "";
    if (typeof publicationId !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(publicationId)) throw new Error("meet_visual_request_invalid");
    const controller = new AbortController(); this.controller = controller;
    this.publicationId = publicationId; this.subscriptionId = crypto.randomUUID().replaceAll("-", "");
    this.lastNow = Date.now();
    try {
      this.source = this.mesh.machineVisualSource(publicationId);
      const binding = this.currentBinding(); this.binding = JSON.stringify(binding);
      this.deadline = Math.min(this.lastNow + VISUAL_LIMITS.lifetimeMs, binding.deadline_ms);
      this.check();
      this.timer = setInterval(() => { try { this.check(); } catch { /* Already closed. */ } }, 100);
      const surface = await visualOperation(this.surfaces.connect(this.source.track, controller.signal),
        controller.signal, VISUAL_LIMITS.operationMs, value => value.close());
      if (this.controller !== controller) { surface.close(); throw new Error("meet_visual_cancelled"); }
      this.surface = surface; this.check();
      return Object.freeze({ schema: "ananta.meet-visual-subscription.v1", subscriptionId: this.subscriptionId,
        binding, format: "image/jpeg", limits: VISUAL_LIMITS });
    } catch {
      if (this.controller === controller) this.stop("meet_visual_open_failed");
      throw new Error("meet_visual_open_failed");
    }
  }
  private currentBinding() {
    const context = this.session.machineContext(), lease = this.session.machineLease(), own = this.mesh.ownPeerId();
    if (!context || !lease || !this.session.joined() || lease.expiresAt <= Date.now()) throw new Error("meet_visual_lease_denied");
    const source = this.mesh.machineVisualSource(this.publicationId);
    if (source.track !== this.source?.track) throw new Error("meet_visual_source_changed");
    const grant = this.mesh.machineReceive.grants().find(g => g.machinePeerId === own && g.publisherPeerId === source.peerId
      && g.publicationIds.includes(this.publicationId) && g.expiresAt > Date.now());
    const membershipEpoch = this.mesh.membershipEpoch(), revision = this.mesh.machineReceive.revision();
    if (!grant || membershipEpoch < 1 || revision < 1) throw new Error("meet_visual_source_denied");
    return Object.freeze({ tenant_id: context.tenantId, project_id: context.projectId, task_id: context.taskId,
      lease_id: lease.sessionId, runtime_id: context.runtimeId, session_id: context.hubSessionId,
      generation: lease.generation, room_id: this.session.roomId(), membership_epoch: membershipEpoch,
      peer_id: source.peerId, own_peer_id: own, publication_id: this.publicationId,
      publication_epoch: source.publicationEpoch, receive_revision: revision, source: source.source,
      deadline_ms: Math.min(lease.expiresAt, grant.expiresAt) });
  }
  private check() {
    try {
      const now = Date.now();
      if (!this.controller || this.controller.signal.aborted || now < this.lastNow || now >= this.deadline
        || JSON.stringify(this.currentBinding()) !== this.binding) throw new Error("meet_visual_binding_changed");
      this.lastNow = now;
    } catch { this.stop("meet_visual_binding_changed"); throw new Error("meet_visual_binding_changed"); }
  }
  async frame(subscriptionId: string) {
    this.check();
    if (subscriptionId !== this.subscriptionId || !this.surface || this.busy
      || this.sequence >= VISUAL_LIMITS.frames || Date.now() - this.lastFrame < VISUAL_LIMITS.intervalMs) {
      throw new Error("meet_visual_frame_denied");
    }
    this.busy = true;
    const controller = this.controller!;
    let pixels: VisualPixels | null = null;
    try {
      pixels = await visualOperation(this.surface.frame(), controller.signal, VISUAL_LIMITS.operationMs, value => value.bytes.fill(0));
      if (this.controller !== controller) throw new Error("meet_visual_cancelled");
      this.check();
      if (!(pixels.bytes instanceof Uint8Array) || pixels.bytes.length < 1 || pixels.bytes.length > VISUAL_LIMITS.bytes
        || !Number.isSafeInteger(pixels.width) || pixels.width < 1 || pixels.width > VISUAL_LIMITS.width
        || !Number.isSafeInteger(pixels.height) || pixels.height < 1 || pixels.height > VISUAL_LIMITS.height) throw new Error("meet_visual_frame_invalid");
      let encoded = "";
      for (let i = 0; i < pixels.bytes.length; i += 8192) encoded += String.fromCharCode(...pixels.bytes.subarray(i, i + 8192));
      this.lastFrame = Date.now();
      const result = Object.freeze({ schema: "ananta.meet-visual-frame.v1", subscriptionId, sequence: ++this.sequence,
        width: pixels.width, height: pixels.height, jpegBase64: btoa(encoded) });
      if (this.sequence === VISUAL_LIMITS.frames) { this.surface!.close(); this.surface = null; }
      return result;
    } catch {
      if (this.controller === controller) this.stop("meet_visual_frame_failed");
      throw new Error("meet_visual_frame_failed");
    } finally { pixels?.bytes.fill(0); if (this.controller === controller) this.busy = false; }
  }
  status() { return Object.freeze({ open: Boolean(this.controller), frames: this.sequence, error: this.error }); }
  private stop(code: string) { this.error = code; this.close(); }
  close(): void {
    this.controller?.abort(); this.controller = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    try { this.surface?.close(); } finally {
      this.surface = null; this.source = null; this.publicationId = this.subscriptionId = this.binding = "";
      this.sequence = 0; this.lastFrame = -Infinity; this.busy = false;
    }
  }
  ngOnDestroy() { this.close(); }
}
