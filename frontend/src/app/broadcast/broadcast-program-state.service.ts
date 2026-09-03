import { Injectable, signal } from "@angular/core";

import {
  BroadcastBrowserPortError,
  BroadcastProgramRef,
  BroadcastPublicationSession,
} from "./broadcast-ports";

export type BroadcastBrowserLifecycle = "idle" | "starting" | "running" | "stopping" | "failed";

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
    if (lifecycle === "starting" || lifecycle === "running" || lifecycle === "stopping") {
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
}
