import type { NativeCapacityPreview } from "./native-capacity-preview";
import type { NativeSourceProgramRequest } from "./native-source-program-controller";

export interface CapacityPreviewState {
  phase: "idle" | "pending" | "current" | "stale" | "unavailable";
  value: NativeCapacityPreview | null;
}
interface Ports {
  context(): { key: string; request: NativeSourceProgramRequest } | null;
  query(request: NativeSourceProgramRequest, signal: AbortSignal): Promise<NativeCapacityPreview>;
  changed(state: CapacityPreviewState): void;
  now(): number;
}
/** Local advisory observation. Never authorizes start, media or capture. */
export class NativeCapacityPreviewController {
  private current: { key: string; abort: AbortController; deadline: number } | null = null;
  private destroyed = false;
  constructor(private readonly ports: Ports) {}
  tick(): void {
    if (this.current && (this.current.key !== this.ports.context()?.key || this.ports.now() >= this.current.deadline)) {
      this.clear(); this.ports.changed({ phase: "stale", value: null });
    }
  }
  async query(): Promise<void> {
    if (this.destroyed) return;
    this.clear();
    const context = this.ports.context();
    if (!context) { this.ports.changed({ phase: "unavailable", value: null }); return; }
    const started = this.ports.now();
    const operation = { key: context.key, abort: new AbortController(), deadline: started + 5000 };
    this.current = operation; this.ports.changed({ phase: "pending", value: null });
    try {
      const value = await this.ports.query(context.request, operation.abort.signal);
      if (this.current !== operation || this.destroyed) return;
      operation.deadline = Math.min(operation.deadline, started + value.expiresAt - value.observedAt);
      this.tick();
      if (this.current === operation) this.ports.changed({ phase: "current", value });
    } catch {
      if (this.current !== operation || this.destroyed) return;
      this.clear(); this.ports.changed({ phase: "unavailable", value: null });
    }
  }
  private clear(): void { const previous = this.current; this.current = null; previous?.abort.abort(); }
  destroy(): void { this.destroyed = true; this.clear(); }
}
