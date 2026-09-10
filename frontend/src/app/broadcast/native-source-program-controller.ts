import type { BroadcastProgramRef } from "./broadcast-ports";
import type { PreparedNativePackagerStart } from "./broadcast-control-plane.service";
import type { NativePackagerHandoffControl } from "./native-packager-handoff-control";
import type { NativeSourceAudioOutput } from "./native-source-audio-output";
import type { NativeSourceVideoOutput } from "./native-source-video-output";

export interface NativeSourceProgramRequest {
  readonly roomId: string; readonly title: string; readonly visibility: "private" | "unlisted" | "public";
  readonly packagerId: string; readonly requestedRenditions: number; readonly allowHardwareAcceleration: boolean;
  readonly audioOutput?: NativeSourceAudioOutput;
  readonly videoOutput?: NativeSourceVideoOutput;
}
export interface NativeSourceProgramView {
  readonly phase: "idle" | "preparing" | "waiting-output" | "live" | "degraded" | "handing-over" | "stopping" | "stopped" | "failed";
  readonly active: boolean; readonly program: BroadcastProgramRef | null; readonly error: string;
}
export interface NativeSourceProgramPorts {
  context(): string | null;
  eligible(packagerId: string, requestedRenditions: number, audioOutput?: NativeSourceAudioOutput): boolean;
  create(request: NativeSourceProgramRequest, signal: AbortSignal): Promise<BroadcastProgramRef>;
  prepare(program: BroadcastProgramRef, request: NativeSourceProgramRequest, signal: AbortSignal): Promise<{
    program: BroadcastProgramRef; assignment: PreparedNativePackagerStart;
  }>;
  observe(programId: string, signal: AbortSignal): Promise<NativePackagerHandoffControl>;
  handoff?(program: BroadcastProgramRef, snapshot: NativePackagerHandoffControl, request: NativeSourceProgramRequest,
    signal: AbortSignal): Promise<{ program: BroadcastProgramRef; assignment: PreparedNativePackagerStart }>;
  stop(program: BroadcastProgramRef, assignment: PreparedNativePackagerStart | undefined): Promise<void>;
  changed(view: NativeSourceProgramView): void;
  clock?: () => number;
}
interface ActiveProgram {
  readonly context: string; request: NativeSourceProgramRequest; readonly controller: AbortController;
  startedAt: number; observationGeneration: number;
  handoff?: { request: NativeSourceProgramRequest; startedAt: number };
  program?: BroadcastProgramRef; assignment?: PreparedNativePackagerStart;
  pending?: Promise<void>; stopping?: Promise<void>; polling: boolean; nextPoll: number; ready: boolean; lastNow: number;
  cancelled?: boolean;
}

/** Control only. No capture, keys, PeerConnection, automatic consent or source restart. */
export class NativeSourceProgramController {
  standbyOutput(): Readonly<Pick<NativeSourceProgramRequest, "requestedRenditions" | "allowHardwareAcceleration">> | null {
    const active = this.active;
    if (!active?.ready || active.controller.signal.aborted || !this.controlledPackagerId()) return null;
    return Object.freeze({ requestedRenditions: active.request.requestedRenditions,
      allowHardwareAcceleration: active.request.allowHardwareAcceleration });
  }
  controlledPackagerId(): string | null {
    const active = this.active;
    return !this.destroyed && active && !active.cancelled && active.context === this.ports.context()
      && ["live", "degraded"].includes(this.phase) ? active.assignment?.packagerId ?? null : null;
  }
  private active: ActiveProgram | null = null;
  private phase: NativeSourceProgramView["phase"] = "idle";
  private error = "";
  private destroyed = false;
  private startGeneration = 0;
  private readonly now: () => number;
  constructor(private readonly ports: NativeSourceProgramPorts) { this.now = ports.clock ?? Date.now; }

  async start(input: NativeSourceProgramRequest, trigger: unknown): Promise<void> {
    const context = this.ports.context();
    if (this.destroyed || this.active || !context || trigger !== "user-action") throw new Error("native_source_program_start_denied");
    const generation = ++this.startGeneration;
    // Detach the click's choice before module loading yields to other events.
    const snapshot = { ...input, ...(input?.audioOutput ? { audioOutput: { ...input.audioOutput } } : {}),
      ...(input?.videoOutput ? { videoOutput: { ...input.videoOutput } } : {}) };
    const request = (await import("./native-source-program-request")).normalizeSourceProgramRequest(snapshot);
    if (this.destroyed || this.active || generation !== this.startGeneration || context !== this.ports.context()
      || !this.ports.eligible(request.packagerId, request.requestedRenditions, request.audioOutput)) {
      throw new Error("native_source_program_start_denied");
    }
    const record: ActiveProgram = { context, request,
      controller: new AbortController(), startedAt: this.now(), lastNow: this.now(), polling: false, nextPoll: 0, ready: false,
      observationGeneration: 0 };
    this.active = record; this.phase = "preparing"; this.error = ""; this.emit();
    record.pending = this.prepare(record);
    await record.pending;
  }

  private async prepare(record: ActiveProgram): Promise<void> {
    const signal = AbortSignal.any([record.controller.signal, AbortSignal.timeout(15000)]);
    try {
      const program = await this.ports.create(record.request, signal);
      // Retain a late known creation for cleanup, never for a new activation.
      record.program = program;
      this.requireCurrent(record); signal.throwIfAborted();
      if (program.roomId !== record.request.roomId) throw new Error("native_source_program_scope_changed");
      const prepared = await this.ports.prepare(program, record.request, signal);
      record.program = prepared.program; record.assignment = prepared.assignment;
      this.requireCurrent(record); signal.throwIfAborted();
      this.phase = "waiting-output"; this.emit();
      await this.observe(record);
    } catch {
      if (!record.cancelled) this.error ||= "native_source_program_start_failed";
      record.controller.abort();
      await this.cleanup(record);
    }
  }

  private requireCurrent(record: ActiveProgram): void {
    record.controller.signal.throwIfAborted();
    const request = record.handoff?.request ?? record.request;
    if (this.active !== record || this.destroyed || this.ports.context() !== record.context
      || !this.ports.eligible(request.packagerId, request.requestedRenditions, request.audioOutput)
      || this.now() < record.lastNow) throw new Error("native_source_program_context_changed");
    record.lastNow = this.now();
  }

  private async observe(record: ActiveProgram): Promise<void> {
    if (!record.program || !record.assignment || record.polling || record.handoff) return;
    const generation = record.observationGeneration;
    record.polling = true;
    try {
      this.requireCurrent(record);
      const value = await this.ports.observe(record.program.programId,
        AbortSignal.any([record.controller.signal, AbortSignal.timeout(5000)]));
      if (generation !== record.observationGeneration) return;
      this.requireCurrent(record);
      if (value.programId !== record.program.programId || value.programEpoch !== record.program.programEpoch
        || value.programRevision < record.program.programRevision || value.handoffPending
        || value.writer?.packagerId !== record.assignment.packagerId
        || value.writer?.fencingRevision !== record.assignment.fencingRevision
        || !["preparing", "awaiting_consent", "publishing", "live", "degraded"].includes(value.state)) {
        throw new Error("native_source_program_writer_changed");
      }
      record.program = Object.freeze({ ...record.program, programRevision: value.programRevision });
      if (value.state === "live") record.ready = true;
      this.phase = record.ready && value.state === "live" ? "live"
        : record.ready && value.state === "degraded" ? "degraded" : "waiting-output";
      record.nextPoll = this.now() + 2000; this.emit();
    } catch {
      if (generation === record.observationGeneration && !record.controller.signal.aborted) {
        this.error = "native_source_program_confirmation_lost"; record.controller.abort();
        await this.cleanup(record);
      }
    } finally { if (generation === record.observationGeneration) record.polling = false; }
  }

  canHandoff(packagerId: string): boolean {
    const record = this.active;
    return !!record && !!this.ports.handoff && !this.destroyed && !record.controller.signal.aborted
      && !record.handoff && record.ready && ["live", "degraded"].includes(this.phase)
      && record.context === this.ports.context() && /^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId)
      && packagerId !== record.assignment?.packagerId
      && this.ports.eligible(packagerId, record.request.requestedRenditions, record.request.audioOutput);
  }

  async handoff(packagerId: string, trigger: unknown): Promise<void> {
    if (trigger !== "user-action" || !this.canHandoff(packagerId)) throw new Error("native_source_handoff_denied");
    const record = this.active!;
    this.requireCurrent(record);
    record.handoff = { request: Object.freeze({ ...record.request, packagerId }), startedAt: this.now() };
    ++record.observationGeneration; record.polling = false;
    this.phase = "handing-over"; this.error = ""; this.emit();
    record.pending = this.transfer(record);
    await record.pending;
  }

  private async transfer(record: ActiveProgram): Promise<void> {
    const target = record.handoff!.request;
    const signal = AbortSignal.any([record.controller.signal, AbortSignal.timeout(15000)]);
    try {
      const previous = record.program!, assignment = record.assignment!;
      const snapshot = await this.ports.observe(previous.programId, signal);
      this.requireCurrent(record); signal.throwIfAborted();
      if (snapshot.programId !== previous.programId || snapshot.programEpoch !== previous.programEpoch
        || snapshot.programRevision < previous.programRevision || snapshot.handoffPending
        || !["live", "degraded"].includes(snapshot.state) || snapshot.writer?.packagerId !== assignment.packagerId
        || snapshot.writer.fencingRevision !== assignment.fencingRevision) throw new Error("native_source_handoff_stale");
      const result = await this.ports.handoff!(previous, snapshot, target, signal);
      // Retain late known assignments for cleanup, not for activation.
      record.program = result.program; record.assignment = result.assignment;
      this.requireCurrent(record); signal.throwIfAborted();
      record.request = target; record.handoff = undefined; record.ready = false; record.startedAt = this.now();
      this.phase = "waiting-output"; this.emit();
      await this.observe(record);
    } catch {
      if (!record.cancelled) this.error ||= "native_source_handoff_failed";
      record.controller.abort(); await this.cleanup(record);
    }
  }

  tick(): void {
    const record = this.active;
    if (!record) return;
    if (record.controller.signal.aborted) { this.emit(); return; }
    try {
      this.requireCurrent(record);
      if (record.handoff) {
        if (this.now() >= record.handoff.startedAt + 15000) throw new Error();
        return;
      }
      if (!record.ready && this.now() >= record.startedAt + 45000) throw new Error();
      if (record.ready && this.now() >= record.nextPoll + 5000) throw new Error();
    } catch {
      this.error = "native_source_program_context_or_deadline_lost";
      void this.stop(); return;
    }
    if (record.assignment && this.now() >= record.nextPoll) void this.observe(record);
  }

  async stop(): Promise<void> {
    ++this.startGeneration;
    const record = this.active;
    if (!record) return;
    record.cancelled = true;
    ++record.observationGeneration;
    record.controller.abort(); this.phase = "stopping"; this.emit();
    await record.pending;
    // prepare() may have already completed the exact cleanup while aborting.
    if (this.active === record) await this.cleanup(record);
  }

  private cleanup(record: ActiveProgram): Promise<void> {
    if (record.stopping) return record.stopping;
    this.phase = "stopping"; this.emit();
    const task = (async () => {
      try {
        if (record.program) await this.ports.stop(record.program, record.assignment);
        if (this.active === record) { this.active = null; this.phase = this.error ? "failed" : "stopped"; }
      } catch { this.phase = "failed"; this.error = "native_source_program_stop_unconfirmed"; }
      this.emit();
    })();
    record.stopping = task;
    return task.finally(() => { if (record.stopping === task) record.stopping = undefined; });
  }

  destroy(): void { this.destroyed = true; void this.stop(); }
  private emit(): void {
    this.ports.changed(Object.freeze({ phase: this.phase, active: !!this.active, error: this.error,
      program: this.active?.context === this.ports.context() ? this.active.program ?? null : null }));
  }
}
