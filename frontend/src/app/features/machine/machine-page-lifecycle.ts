import { SessionOperation } from "../../webrtc/session-operation";

export interface MachinePageLifecyclePorts {
  load(): Promise<unknown>;
  join(roomId: string, grant: string): Promise<void>;
  joined(): boolean;
  /** Independent, idempotent endpoint cleanup; one failure must not skip another. */
  cleanup: readonly (() => void | boolean)[];
  cleanupFailed(): void;
}

/** Owns only page operations, never grants, session renewal or reconnect policy. */
export class MachinePageLifecycle {
  private generation = 0;
  private destroyed = false;
  private pending: SessionOperation | null = null;
  // Detached resource handles may make a later close a no-op. Only a fresh
  // page can recover from an unconfirmed stop, never a new grant on this page.
  private quarantined = false;
  constructor(private readonly ports: MachinePageLifecyclePorts) {}

  async join(roomId: string, grant: string): Promise<void> {
    if (this.destroyed) throw new Error("machine_cancelled");
    if (this.quarantined) throw new Error("machine_cleanup_failed");
    this.leave();
    if (this.quarantined) throw new Error("machine_cleanup_failed");
    if (typeof grant !== "string" || !grant || grant.length > 4096
      || typeof roomId !== "string" || !/^room-[a-f0-9]{18}$/.test(roomId)) {
      throw new Error("machine_join_invalid");
    }
    const generation = this.generation;
    const current = () => generation === this.generation && !this.destroyed;
    const operation = new SessionOperation(20_000, "machine_operation_bounded_stop", "machine_cancelled");
    this.pending = operation;
    try {
      await operation.wait(() => this.ports.load());
      if (!current()) throw new Error("machine_cancelled");
      await operation.wait(() => this.ports.join(roomId, grant));
      if (!current()) throw new Error("machine_cancelled");
      while (!this.ports.joined()) {
        if (!current()) throw new Error("machine_cancelled");
        await operation.pause(50);
      }
      if (!current()) throw new Error("machine_cancelled");
    } catch (error) {
      // Only this operation may retire its admission. An older continuation
      // must never close the replacement session or its publications.
      if (current()) this.leave();
      throw error;
    } finally {
      operation.dispose();
      if (this.pending === operation) this.pending = null;
    }
  }

  leave(): void {
    ++this.generation;
    this.pending?.abort(); this.pending = null;
    let failed = false;
    for (const close of this.ports.cleanup) {
      try { if (close() === false) failed = true; } catch { failed = true; }
    }
    if (failed) {
      this.quarantined = true;
      try { this.ports.cleanupFailed(); } catch { /* Reporting cannot restore authority or expose private errors. */ }
    }
  }

  destroy(): void { this.destroyed = true; this.leave(); }
}
