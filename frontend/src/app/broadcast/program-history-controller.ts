import { parseProgramHistory, type ProgramHistory } from "./program-history";
import type { PlaybackCapacityScope } from "./playback-capacity";
export interface ProgramHistoryView { phase: "idle" | "pending" | "ready" | "stale" | "unavailable"; value: ProgramHistory | null; }
interface Context { key: string; program: PlaybackCapacityScope; }
interface Ports {
  context(): Context | null; query(program: PlaybackCapacityScope, signal: AbortSignal): Promise<ProgramHistory>;
  changed(view: ProgramHistoryView): void; now(): number;
}
const keyFor = (c: Context | null) => c && JSON.stringify([c.key, c.program.programId, c.program.programEpoch, c.program.programRevision]);
export class ProgramHistoryController {
  private current: { key: string; abort: AbortController; started: number; last: number; deadline: number } | null = null;
  private destroyed = false;
  constructor(private readonly ports: Ports) {}
  tick(): void {
    const op = this.current; if (!op) return;
    const now = this.ports.now();
    if (!Number.isFinite(now) || now < op.last || now >= op.deadline || keyFor(this.ports.context()) !== op.key) {
      this.clear(); this.ports.changed({ phase: "stale", value: null });
    } else op.last = now;
  }
  async query(): Promise<void> {
    if (this.destroyed) return; this.clear();
    const context = this.ports.context(), started = this.ports.now();
    if (!context || !Number.isFinite(started) || started < 0) { this.ports.changed({ phase: "unavailable", value: null }); return; }
    const program = { ...context.program };
    const op = { key: keyFor(context)!, started, last: started, deadline: started + 5000, abort: new AbortController() };
    this.current = op; this.ports.changed({ phase: "pending", value: null });
    try {
      const raw = await this.ports.query(program, op.abort.signal);
      if (this.current !== op || this.destroyed) return;
      const value = parseProgramHistory(raw, program);
      op.deadline = Math.min(op.deadline, started + value.expiresAt - value.observedAt);
      this.tick(); if (this.current === op) this.ports.changed({ phase: "ready", value });
    } catch {
      if (this.current !== op || this.destroyed) return;
      this.clear(); this.ports.changed({ phase: "unavailable", value: null });
    }
  }
  private clear(): void { const op = this.current; this.current = null; op?.abort.abort(); }
  destroy(): void { this.destroyed = true; this.clear(); }
}
