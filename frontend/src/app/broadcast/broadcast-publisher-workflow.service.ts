import { Injectable, signal } from "@angular/core";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { BroadcastCoordinatorService } from "./broadcast-coordinator.service";
import { BroadcastOwnSourcePreflightService, BroadcastPreflightAudience } from "./broadcast-own-source-preflight.service";
import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";

export interface BroadcastPublisherStartRequest {
  readonly requestVersion: 1;
  readonly trigger: "user-action";
  readonly roomId: string;
  readonly title: string;
  readonly visibility: BroadcastPreflightAudience;
  readonly sourceIds: readonly string[];
  readonly adapterId?: "whip-browser" | "native-bridge";
  readonly packagerId?: string;
  readonly requestedRenditions?: number;
}

function sessionInstanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `browser_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

@Injectable()
export class BroadcastPublisherWorkflowService {
  readonly busy = signal(false);
  readonly errorCode = signal("");
  readonly activeProgramId = signal("");
  readonly activePackagerId = signal("");
  readonly handingOver = signal(false);
  private controller: AbortController | null = null;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private lastStartRequest: BroadcastPublisherStartRequest | null = null;

  constructor(
    readonly coordinator: BroadcastCoordinatorService,
    private readonly control: BroadcastControlPlaneService,
    private readonly preflight: BroadcastOwnSourcePreflightService,
    private readonly media: MediaPublicationService,
  ) {}

  async start(request: BroadcastPublisherStartRequest): Promise<void> {
    if (request.trigger !== "user-action") {
      throw new BroadcastBrowserPortError("explicit_broadcast_start_required");
    }
    if (this.startTask || this.stopTask || this.busy()) {
      throw new BroadcastBrowserPortError("broadcast_lifecycle_busy");
    }
    const sourceIds = Object.freeze([...request.sourceIds]);
    if (!request.roomId || !request.title.trim() || sourceIds.length < 1 || sourceIds.length > 4) {
      throw new BroadcastBrowserPortError("invalid_broadcast_start_request");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.errorCode.set("");
    const task = this.runStart({ ...request, title: request.title.trim(), sourceIds }, controller.signal);
    this.startTask = task;
    try {
      await task;
    } catch (error) {
      this.errorCode.set(error instanceof Error ? error.message : "broadcast_start_failed");
      throw error;
    } finally {
      if (this.startTask === task) this.startTask = null;
      if (this.controller === controller) this.controller = null;
      this.busy.set(false);
    }
  }

  async setVisibility(visibility: BroadcastPreflightAudience): Promise<void> {
    const request = this.lastStartRequest;
    const state = this.coordinator.programState.value();
    const programId = this.activeProgramId() || state.program?.programId || "";
    if (!programId || !request || !new Set(["running", "degraded", "reconnecting", "handing_over"]).has(state.lifecycle)
      || this.busy() || this.startTask || this.stopTask) {
      throw new BroadcastBrowserPortError("broadcast_lifecycle_busy");
    }
    this.busy.set(true);
    this.errorCode.set("");
    try {
      await this.runStop("visibility-change");
      this.busy.set(true);
      await this.preflight.preparePreview("user-action");
    } catch (error) {
      this.errorCode.set(error instanceof Error ? error.message : "broadcast_visibility_update_failed");
      throw error;
    } finally {
      this.busy.set(false);
    }
    await this.start({ ...request, visibility });
  }

  async stop(reason = "user-stop"): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.runStop(reason);
    this.stopTask = task;
    try { await task; } finally { if (this.stopTask === task) this.stopTask = null; }
  }

  async handoff(packagerId: string, requestedRenditions: number, trigger: unknown): Promise<void> {
    if (trigger !== "user-action") throw new BroadcastBrowserPortError("explicit_broadcast_handoff_required");
    const request = this.lastStartRequest;
    const state = this.coordinator.programState.value();
    if (this.busy() || this.startTask || this.stopTask || !request || request.adapterId !== "native-bridge"
      || !state.program || !["running", "degraded"].includes(state.lifecycle)
      || typeof packagerId !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId) || packagerId === this.activePackagerId()
      || !Number.isSafeInteger(requestedRenditions) || requestedRenditions < 1 || requestedRenditions > 3) {
      throw new BroadcastBrowserPortError("invalid_native_handoff_request");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.handingOver.set(true);
    this.errorCode.set("");
    const timeout = setTimeout(() => controller.abort(new DOMException("broadcast_handoff_timeout", "TimeoutError")), 75_000);
    const task = this.runHandoff(request, state.program, packagerId, requestedRenditions, controller.signal);
    this.startTask = task;
    try { await task; }
    catch (error) {
      this.errorCode.set(error instanceof Error ? error.message : "broadcast_handoff_failed");
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.startTask === task) this.startTask = null;
      if (this.controller === controller) this.controller = null;
      this.handingOver.set(false);
      this.busy.set(false);
    }
  }

  private async runHandoff(
    request: BroadcastPublisherStartRequest, program: BroadcastProgramRef,
    packagerId: string, requestedRenditions: number, signal: AbortSignal,
  ): Promise<void> {
    // A failed read cannot have changed the remote writer. The old publication stays intact.
    const snapshot = await this.control.nativeHandoffControl(program.programId, signal);
    signal.throwIfAborted();
    if (snapshot.programEpoch !== program.programEpoch || snapshot.writer?.packagerId !== this.activePackagerId()
      || snapshot.handoffPending || !["live", "degraded"].includes(snapshot.state)) {
      throw new BroadcastBrowserPortError("broadcast_state_conflict");
    }
    this.coordinator.programState.handingOver("broadcast_packager_handoff");
    let successorInstalled = false;
    try {
      const prepared = await this.control.prepareNativeHandoff(program, snapshot, packagerId, requestedRenditions, signal);
      successorInstalled = true;
      signal.throwIfAborted();
      // This stops only local forks and the old assignment, never the program itself.
      await this.coordinator.stop("packager-handoff");
      signal.throwIfAborted();
      await this.startPrepared({ ...request, packagerId, requestedRenditions }, prepared, signal);
    } catch (error) {
      let unchangedWriter = false;
      if (!successorInstalled && !signal.aborted) {
        try {
          const current = await this.control.nativeHandoffControl(program.programId, AbortSignal.timeout(5_000));
          signal.throwIfAborted();
          if (current.programEpoch === snapshot.programEpoch && !current.handoffPending
            && current.writer?.packagerId === snapshot.writer?.packagerId
            && current.writer?.fencingRevision === snapshot.writer?.fencingRevision
            && ["live", "degraded"].includes(current.state)) {
            this.coordinator.programState.resumeRunning();
            if (current.state === "degraded") this.coordinator.programState.degraded("broadcast_degraded");
            unchangedWriter = true;
          }
        } catch { /* Unknown writer state is not permission to resume an old publication. */ }
      }
      if (unchangedWriter) throw error;
      try { await this.coordinator.stop("handoff-failed"); } catch { /* Attempt server revoke independently. */ }
      try { await this.control.stopProgram(program.programId, AbortSignal.timeout(12_000)); } catch { /* Visible failure, no restart. */ }
      this.control.clear(program.programId);
      this.activeProgramId.set("");
      this.activePackagerId.set("");
      this.lastStartRequest = null;
      throw error;
    }
  }

  async resetForSession(): Promise<void> {
    let firstError: unknown = null;
    try { await this.stop("session-reset"); } catch (error) { firstError = error; }
    try { await this.preflight.resetForSession(); } catch (error) { firstError ||= error; }
    if (firstError) throw firstError;
  }

  private async runStart(
    request: BroadcastPublisherStartRequest,
    signal: AbortSignal,
  ): Promise<void> {
    let programId = "";
    try {
      const created = await this.control.createProgram(
        request.roomId,
        request.title,
        request.visibility,
        signal,
      );
      programId = created.programId;
      this.activeProgramId.set(programId);
      const adapterId = request.adapterId || "whip-browser";
      if (adapterId !== "whip-browser" && adapterId !== "native-bridge") {
        throw new BroadcastBrowserPortError("invalid_broadcast_adapter");
      }
      const prepared = adapterId === "native-bridge"
        ? await this.control.prepareNativeStart(
          created,
          request.sourceIds,
          request.packagerId || "",
          request.requestedRenditions || 1,
          signal,
        )
        : await this.control.prepareStart(created, request.sourceIds, signal);
      await this.startPrepared(request, prepared, signal);
    } catch (error) {
      try { await this.coordinator.stop("start-failed"); } catch { /* Revoke the server independently. */ }
      if (programId) {
        try { await this.control.stopProgram(programId, new AbortController().signal); } catch { /* bounded orphan cleanup */ }
      }
      this.activeProgramId.set("");
      this.activePackagerId.set("");
      throw error;
    }
  }

  private async startPrepared(
    request: BroadcastPublisherStartRequest,
    prepared: Readonly<{ program: BroadcastProgramRef; ownerSubjectRef: string }>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const sources = this.media.localOriginalSources()
      .filter(({ sourceId }) => request.sourceIds.includes(sourceId))
      .map((source) => Object.freeze({
        sourceId: source.sourceId,
        ownerSubjectRef: prepared.ownerSubjectRef,
        kind: source.source,
        local: true,
        active: true,
      }));
    if (sources.length !== request.sourceIds.length) {
      throw new BroadcastBrowserPortError("broadcast_source_changed");
    }
    await this.preflight.stopPreview("broadcast-start");
    signal.throwIfAborted();
    await this.coordinator.start({
      planVersion: 1,
      trigger: "user-action",
      program: prepared.program,
      roomPublication: {
        snapshotVersion: 1,
        sessionInstanceId: sessionInstanceId(),
        roomId: request.roomId,
        publicationRevision: this.media.localPublicationRevision(),
        sources,
      },
      sourceIds: request.sourceIds,
      adapterId: request.adapterId || "whip-browser",
    }, signal);
    signal.throwIfAborted();
    this.activePackagerId.set(request.adapterId === "native-bridge" ? request.packagerId || "" : "");
    this.lastStartRequest = Object.freeze({ ...request, sourceIds: Object.freeze([...request.sourceIds]) });
  }

  private async runStop(reason: string): Promise<void> {
    this.controller?.abort(new DOMException(reason, "AbortError"));
    if (this.startTask) {
      try { await this.startTask; } catch { /* runStart already revokes a partially created program */ }
    }
    const programId = this.activeProgramId()
      || this.coordinator.programState.value().program?.programId
      || "";
    let firstError: unknown = null;
    if (this.coordinator.programState.value().program) {
      try { await this.coordinator.stop(reason); } catch (error) { firstError = error; }
    }
    if (programId) {
      try {
        await this.control.stopProgram(programId, new AbortController().signal);
      } catch (error) {
        firstError ||= error;
      }
    }
    this.activeProgramId.set("");
    this.activePackagerId.set("");
    this.busy.set(false);
    if (reason !== "visibility-change") this.lastStartRequest = null;
    if (firstError) {
      this.errorCode.set(firstError instanceof Error ? firstError.message : "broadcast_stop_failed");
      throw firstError;
    }
  }
}
