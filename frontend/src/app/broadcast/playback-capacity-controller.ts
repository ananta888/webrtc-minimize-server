import { parsePlaybackCapacity, type PlaybackCapacity, type PlaybackCapacityScope } from "./playback-capacity";

export interface PlaybackCapacityState {
  phase: "idle" | "pending" | "current" | "stale" | "unavailable";
  value: PlaybackCapacity | null;
}
interface Context { key: string; program: PlaybackCapacityScope; additionalSessions: number; }
interface Ports {
  context(): Context | null;
  query(program: PlaybackCapacityScope, additional: number, signal: AbortSignal): Promise<PlaybackCapacity>;
  changed(state: PlaybackCapacityState): void;
  now(): number;
}
const keyFor = (c: Context | null) => c && JSON.stringify([c.key, c.program.programId,
  c.program.programEpoch, c.program.programRevision, c.additionalSessions]);
/** An observation expires from request start, never from receipt. No capture/admission port. */
export class PlaybackCapacityController {
  private operation: { key: string; abort: AbortController; start: number; last: number; deadline: number } | null = null;
  private destroyed = false;
  constructor(private readonly ports: Ports) {}
  tick(): void {
    const op = this.operation;
    if (!op) return;
    const now = this.ports.now();
    if (!Number.isFinite(now) || now < op.last || now >= op.deadline || keyFor(this.ports.context()) !== op.key) {
      this.clear(); this.ports.changed({ phase: "stale", value: null });
    } else op.last = now;
  }
  async query(): Promise<void> {
    if (this.destroyed) return;
    this.clear();
    const c = this.ports.context(), start = this.ports.now();
    if (!c || !Number.isFinite(start) || start < 0 || !Number.isSafeInteger(c.additionalSessions)
      || c.additionalSessions < 1 || c.additionalSessions > 10000) {
      this.ports.changed({ phase: "unavailable", value: null }); return;
    }
    const program = { ...c.program }, additional = c.additionalSessions;
    const op = { key: keyFor(c)!, abort: new AbortController(), start, last: start, deadline: start + 5000 };
    this.operation = op; this.ports.changed({ phase: "pending", value: null });
    try {
      const raw = await this.ports.query(program, additional, op.abort.signal);
      if (this.operation !== op || this.destroyed) return;
      const value = parsePlaybackCapacity(raw, program, additional);
      op.deadline = Math.min(op.deadline, start + value.expiresAt - value.observedAt);
      this.tick();
      if (this.operation === op) this.ports.changed({ phase: "current", value });
    } catch {
      if (this.operation !== op || this.destroyed) return;
      this.clear(); this.ports.changed({ phase: "unavailable", value: null });
    }
  }
  private clear(): void { const op = this.operation; this.operation = null; op?.abort.abort(); }
  destroy(): void { this.destroyed = true; this.clear(); }
}
