import { Inject, Injectable, OnDestroy, signal } from "@angular/core";

import { BroadcastDeliveryCapabilityService } from "./broadcast-delivery-capability.service";
import { normalizeBroadcastStartPlan } from "./broadcast-browser-validation";
import {
  BROADCAST_CAPTURE_FORK_PORT,
  BROADCAST_COMPOSITION_PORT,
  BROADCAST_CONSENT_PORT,
  BROADCAST_STATS_PORT,
  BroadcastBrowserPortError,
  BroadcastCaptureForkHandle,
  BroadcastCaptureForkPort,
  BroadcastCompositionHandle,
  BroadcastCompositionPort,
  BroadcastConsentPort,
  BroadcastPublicationPort,
  BroadcastPublicationSession,
  BroadcastStartPlan,
  BroadcastStatsPort,
  BroadcastStatsSample,
} from "./broadcast-ports";
import { BroadcastProgramStateService } from "./broadcast-program-state.service";
import { BroadcastSourceSelectionService } from "./broadcast-source-selection.service";

interface ActiveResources {
  adapter: BroadcastPublicationPort | null;
  session: BroadcastPublicationSession | null;
  composition: BroadcastCompositionHandle | null;
  forks: BroadcastCaptureForkHandle[];
  unsubscribeStats: (() => void) | null;
}

function emptyResources(): ActiveResources {
  return {
    adapter: null,
    session: null,
    composition: null,
    forks: [],
    unsubscribeStats: null,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof BroadcastBrowserPortError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "broadcast_start_aborted";
  return error instanceof Error && error.message ? error.message : "broadcast_start_failed";
}

function sameSourceIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every((sourceId) => actual.includes(sourceId));
}

function validStatsSample(sample: BroadcastStatsSample): boolean {
  return Boolean(sample)
    && Number.isSafeInteger(sample.sampledAt) && sample.sampledAt > 0
    && Number.isFinite(sample.outboundBitsPerSecond) && sample.outboundBitsPerSecond >= 0
    && Number.isFinite(sample.inboundBitsPerSecond) && sample.inboundBitsPerSecond >= 0
    && Number.isSafeInteger(sample.droppedFrames) && sample.droppedFrames >= 0;
}

@Injectable()
export class BroadcastCoordinatorService implements OnDestroy {
  readonly latestStats = signal<BroadcastStatsSample | null>(null);
  private resources = emptyResources();
  private startController: AbortController | null = null;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    readonly programState: BroadcastProgramStateService,
    readonly sourceSelection: BroadcastSourceSelectionService,
    private readonly capabilities: BroadcastDeliveryCapabilityService,
    @Inject(BROADCAST_CONSENT_PORT) private readonly consent: BroadcastConsentPort,
    @Inject(BROADCAST_CAPTURE_FORK_PORT) private readonly captureFork: BroadcastCaptureForkPort,
    @Inject(BROADCAST_COMPOSITION_PORT) private readonly composition: BroadcastCompositionPort,
    @Inject(BROADCAST_STATS_PORT) private readonly stats: BroadcastStatsPort,
  ) {}

  setPanelVisible(visible: boolean): void {
    this.programState.setPanelVisible(visible);
  }

  async start(plan: BroadcastStartPlan): Promise<void> {
    if (this.destroyed) throw new BroadcastBrowserPortError("broadcast_coordinator_destroyed");
    const normalizedPlan = normalizeBroadcastStartPlan(plan);
    if (this.startTask || this.stopTask || new Set([
      "starting", "running", "degraded", "reconnecting", "handing_over", "stopping",
    ]).has(this.programState.value().lifecycle)) {
      throw new BroadcastBrowserPortError("broadcast_lifecycle_busy");
    }
    this.startController = new AbortController();
    this.programState.begin(normalizedPlan.program);
    const task = this.runStart(normalizedPlan, this.startController.signal);
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = null;
    }
  }

  async retry(plan: BroadcastStartPlan): Promise<void> {
    normalizeBroadcastStartPlan(plan);
    await this.stop("retry");
    await this.start(plan);
  }

  async stop(reason = "user-stop"): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.runStop(reason);
    this.stopTask = task;
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = null;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    try {
      await this.stop("destroy");
    } finally {
      this.programState.setPanelVisible(false);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.startController?.abort(new DOMException("destroy", "AbortError"));
    void this.stop("destroy");
  }

  private async runStart(plan: BroadcastStartPlan, signal: AbortSignal): Promise<void> {
    try {
      const adapter = this.capabilities.require(plan.adapterId);
      this.resources.adapter = adapter;
      const sources = this.sourceSelection.select(
        plan.program,
        plan.roomPublication,
        plan.sourceIds,
      );
      const publicationRevision = this.sourceSelection.publicationRevision(plan.roomPublication);
      const consent = await this.consent.authorize(plan.program, sources, signal);
      signal.throwIfAborted();
      if (!consent || consent.decisionVersion !== 1
        || consent.programEpoch !== plan.program.programEpoch
        || !Number.isSafeInteger(consent.expiresAt) || consent.expiresAt <= Date.now()
        || !Array.isArray(consent.sourceIds)
        || !sameSourceIds(consent.sourceIds, sources.map(({ sourceId }) => sourceId))) {
        throw new BroadcastBrowserPortError("invalid_broadcast_consent_decision");
      }
      for (const source of sources) {
        const fork = await this.captureFork.fork(
          plan.program,
          source,
          publicationRevision,
          signal,
        );
        signal.throwIfAborted();
        if (!fork || fork.sourceId !== source.sourceId || fork.kind !== source.kind) {
          throw new BroadcastBrowserPortError("invalid_broadcast_capture_fork");
        }
        this.resources.forks.push(fork);
        signal.throwIfAborted();
      }
      this.resources.composition = await this.composition.compose(
        plan.program,
        this.resources.forks,
        consent,
        signal,
      );
      signal.throwIfAborted();
      if (!this.resources.composition
        || typeof this.resources.composition.compositionId !== "string"
        || this.resources.composition.compositionId.length < 8
        || this.resources.composition.compositionId.length > 128
        || !Array.isArray(this.resources.composition.sourceIds)
        || !sameSourceIds(this.resources.composition.sourceIds, plan.sourceIds)) {
        throw new BroadcastBrowserPortError("invalid_broadcast_composition");
      }
      this.resources.session = await adapter.start({
        requestVersion: 1,
        program: plan.program,
        composition: this.resources.composition,
      }, signal);
      signal.throwIfAborted();
      if (!this.resources.session
        || typeof this.resources.session.sessionId !== "string"
        || this.resources.session.sessionId.length < 8
        || this.resources.session.sessionId.length > 128
        || this.resources.session.adapterId !== adapter.capability.adapterId
        || this.resources.session.programId !== plan.program.programId
        || this.resources.session.programEpoch !== plan.program.programEpoch) {
        throw new BroadcastBrowserPortError("invalid_broadcast_publication_session");
      }
      this.resources.unsubscribeStats = this.stats.subscribe(
        this.resources.session,
        (sample) => {
          if (validStatsSample(sample)) this.latestStats.set(Object.freeze({ ...sample }));
        },
      );
      if (typeof this.resources.unsubscribeStats !== "function") {
        throw new BroadcastBrowserPortError("invalid_broadcast_stats_subscription");
      }
      this.programState.running(this.resources.session);
    } catch (error) {
      try {
        await this.cleanup();
      } catch {
        // The original start error remains the visible cause; cleanup still attempted every resource.
      }
      if (signal.aborted) this.programState.reset();
      else this.programState.failed(errorCode(error));
      throw error;
    } finally {
      if (this.startController?.signal === signal) this.startController = null;
    }
  }

  private async runStop(reason: string): Promise<void> {
    this.startController?.abort(new DOMException(reason, "AbortError"));
    this.programState.stopping();
    if (this.startTask) {
      try {
        await this.startTask;
      } catch {
        // runStart performs the same reverse-order cleanup before rejecting.
      }
    }
    try {
      await this.cleanup();
      this.programState.stopped(reason === "user-stop" ? "broadcast_stopped_by_user" : `broadcast_stopped_${reason}`);
    } catch (error) {
      this.programState.failed(errorCode(error));
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    if (this.resources.unsubscribeStats) {
      try {
        this.resources.unsubscribeStats();
        this.resources.unsubscribeStats = null;
      } catch (error) {
        errors.push(error);
      }
    }
    this.latestStats.set(null);
    const cleanupSignal = new AbortController().signal;
    if (this.resources.adapter && this.resources.session) {
      try {
        await this.resources.adapter.stop(this.resources.session, cleanupSignal);
        this.resources.session = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.resources.session) this.resources.adapter = null;
    if (this.resources.composition) {
      try {
        await this.composition.release(this.resources.composition);
        this.resources.composition = null;
      } catch (error) {
        errors.push(error);
      }
    }
    for (let index = this.resources.forks.length - 1; index >= 0; index -= 1) {
      const fork = this.resources.forks[index];
      try {
        await this.captureFork.release(fork);
        this.resources.forks.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    this.sourceSelection.clear();
    if (errors.length > 0) throw errors[0];
  }
}
