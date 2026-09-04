import { Injectable, signal } from "@angular/core";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { BroadcastCoordinatorService } from "./broadcast-coordinator.service";
import { BroadcastOwnSourcePreflightService, BroadcastPreflightAudience } from "./broadcast-own-source-preflight.service";
import { BroadcastBrowserPortError } from "./broadcast-ports";

export interface BroadcastPublisherStartRequest {
  readonly requestVersion: 1;
  readonly trigger: "user-action";
  readonly roomId: string;
  readonly title: string;
  readonly visibility: BroadcastPreflightAudience;
  readonly sourceIds: readonly string[];
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
  private controller: AbortController | null = null;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;

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
    const programId = this.activeProgramId() || this.coordinator.programState.value().program?.programId || "";
    if (!programId || this.busy()) throw new BroadcastBrowserPortError("broadcast_lifecycle_busy");
    this.busy.set(true);
    this.errorCode.set("");
    try {
      await this.control.changeVisibility(programId, visibility, new AbortController().signal);
    } catch (error) {
      this.errorCode.set(error instanceof Error ? error.message : "broadcast_visibility_update_failed");
      throw error;
    } finally {
      this.busy.set(false);
    }
  }

  async stop(reason = "user-stop"): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.runStop(reason);
    this.stopTask = task;
    try { await task; } finally { if (this.stopTask === task) this.stopTask = null; }
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
      const prepared = await this.control.prepareStart(created, request.sourceIds, signal);
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
        adapterId: "whip-browser",
      });
    } catch (error) {
      if (programId) {
        try { await this.control.stopProgram(programId, new AbortController().signal); } catch { /* bounded orphan cleanup */ }
      }
      this.activeProgramId.set("");
      throw error;
    }
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
    this.busy.set(false);
    if (firstError) {
      this.errorCode.set(firstError instanceof Error ? firstError.message : "broadcast_stop_failed");
      throw firstError;
    }
  }
}
