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
    try {
      await this.ports.load();
      if (!current()) throw new Error("machine_cancelled");
      await this.ports.join(roomId, grant);
      if (!current()) throw new Error("machine_cancelled");
      const deadline = performance.now() + 20_000;
      while (!this.ports.joined()) {
        if (!current()) throw new Error("machine_cancelled");
        if (performance.now() >= deadline) throw new Error("machine_operation_bounded_stop");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!current()) throw new Error("machine_cancelled");
    } catch (error) {
      // Only this operation may retire its admission. An older continuation
      // must never close the replacement session or its publications.
      if (current()) this.leave();
      throw error;
    }
  }

  leave(): void {
    ++this.generation;
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
