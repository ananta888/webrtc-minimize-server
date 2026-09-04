import { Injectable, signal } from "@angular/core";

import {
  BroadcastBrowserPortError,
  BroadcastProgramRef,
  BroadcastPublicationSession,
} from "./broadcast-ports";

export type BroadcastBrowserLifecycle =
  "idle" | "starting" | "running" | "degraded" | "reconnecting" | "handing_over"
  | "stopping" | "stopped" | "failed";

export interface BroadcastBrowserProgramState {
  readonly lifecycle: BroadcastBrowserLifecycle;
  readonly panelVisible: boolean;
  readonly program: BroadcastProgramRef | null;
  readonly publicationSession: BroadcastPublicationSession | null;
  readonly errorCode: string;
}

const INITIAL_STATE: BroadcastBrowserProgramState = Object.freeze({
  lifecycle: "idle",
  panelVisible: false,
  program: null,
  publicationSession: null,
  errorCode: "",
});

@Injectable()
export class BroadcastProgramStateService {
  readonly value = signal<BroadcastBrowserProgramState>(INITIAL_STATE);

  setPanelVisible(visible: boolean): void {
    this.value.update((state) => Object.freeze({ ...state, panelVisible: visible }));
  }

  begin(program: BroadcastProgramRef): void {
    const lifecycle = this.value().lifecycle;
    if (new Set<BroadcastBrowserLifecycle>([
      "starting", "running", "degraded", "reconnecting", "handing_over", "stopping",
    ]).has(lifecycle)) {
      throw new BroadcastBrowserPortError("broadcast_lifecycle_busy");
    }
    this.value.set(Object.freeze({
      lifecycle: "starting",
      panelVisible: this.value().panelVisible,
      program: Object.freeze({ ...program }),
      publicationSession: null,
      errorCode: "",
    }));
  }

  running(session: BroadcastPublicationSession): void {
    const current = this.value();
    if (current.lifecycle !== "starting" || !current.program
      || current.program.programId !== session.programId
      || current.program.programEpoch !== session.programEpoch) {
      throw new BroadcastBrowserPortError("invalid_broadcast_running_transition");
    }
    this.value.set(Object.freeze({
      ...current,
      lifecycle: "running",
      publicationSession: Object.freeze({ ...session }),
    }));
  }

  stopping(): void {
    const current = this.value();
    if (current.lifecycle === "idle") return;
    this.value.set(Object.freeze({ ...current, lifecycle: "stopping" }));
  }

  degraded(code: string): void {
    this.transitionActive("degraded", code || "broadcast_degraded");
  }

  reconnecting(code: string): void {
    this.transitionActive("reconnecting", code || "broadcast_reconnecting");
  }

  handingOver(code: string): void {
    this.transitionActive("handing_over", code || "broadcast_handing_over");
  }

  resumeRunning(): void {
    const current = this.value();
    if (!new Set<BroadcastBrowserLifecycle>(["degraded", "reconnecting", "handing_over"]).has(current.lifecycle)
      || !current.publicationSession) {
      throw new BroadcastBrowserPortError("invalid_broadcast_resume_transition");
    }
    this.value.set(Object.freeze({ ...current, lifecycle: "running", errorCode: "" }));
  }

  failed(code: string): void {
    const current = this.value();
    this.value.set(Object.freeze({
      ...current,
      lifecycle: "failed",
      publicationSession: null,
      errorCode: code || "broadcast_start_failed",
    }));
  }

  reset(): void {
    this.value.set(Object.freeze({ ...INITIAL_STATE, panelVisible: this.value().panelVisible }));
  }

  stopped(code = "broadcast_stopped"): void {
    const current = this.value();
    this.value.set(Object.freeze({
      lifecycle: "stopped",
      panelVisible: current.panelVisible,
      program: current.program,
      publicationSession: null,
      errorCode: code,
    }));
  }

  private transitionActive(lifecycle: "degraded" | "reconnecting" | "handing_over", code: string): void {
    const current = this.value();
    if (!new Set<BroadcastBrowserLifecycle>(["running", "degraded", "reconnecting", "handing_over"])
      .has(current.lifecycle) || !current.publicationSession) {
      throw new BroadcastBrowserPortError("invalid_broadcast_active_transition");
    }
    this.value.set(Object.freeze({ ...current, lifecycle, errorCode: code }));
  }
}
