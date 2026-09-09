import { NativeAudioResult, NativeAudioSelection, NativeAudioState, validAudioSelection } from "./native-source-audio-contract";
import { BroadcastProgramRef } from "./broadcast-ports";

export interface NativeAudioContext { readonly key: string; readonly program: BroadcastProgramRef; readonly audioControlVersion?: 1 | 2 }
export interface NativeAudioView { readonly phase: "idle" | "pending" | "ready" | "stale" | "conflict" | "unavailable"; readonly audio: NativeAudioState | null }
interface Ports {
  context(): NativeAudioContext | null;
  request(program: BroadcastProgramRef, selection: NativeAudioSelection | null, signal: AbortSignal, version: 1 | 2): Promise<NativeAudioResult>;
  changed(value: NativeAudioView): void;
  clock?: () => number;
}
const same = (a: NativeAudioContext | null, b: NativeAudioContext | null) => a && b && a.key === b.key
  && (a.audioControlVersion ?? 1) === (b.audioControlVersion ?? 1)
  && a.program.programId === b.program.programId && a.program.programRevision === b.program.programRevision && a.program.programEpoch === b.program.programEpoch;

/** No capture/consent/publication ownership. A timed-out apply is uncertain, never retried. */
export class NativeSourceAudioController {
  private audio: NativeAudioState | null = null;
  private context: NativeAudioContext | null = null;
  private pending: AbortController | null = null;
  private closed = false;
  private lastNow = 0;
  private readonly now: () => number;
  constructor(private readonly ports: Ports) { this.now = ports.clock || Date.now; }
  private emit(phase: NativeAudioView["phase"]): void { this.ports.changed(Object.freeze({ phase, audio: this.audio })); }
  private current(): boolean {
    const now = this.now(), valid = Number.isSafeInteger(now) && now >= this.lastNow && same(this.context, this.ports.context());
    this.lastNow = now;
    return !!valid;
  }
  tick(): void {
    if (this.closed) return;
    if (this.context && (!this.current() || this.audio && this.now() >= this.audio.observedAt + 5000)) {
      this.pending?.abort(); this.pending = null; this.audio = null; this.context = null; this.emit("stale");
    }
  }
  async refresh(): Promise<void> { await this.run(null); }
  async apply(selection: NativeAudioSelection, trigger: unknown): Promise<void> {
    this.tick();
    if (trigger !== "user-action" || !this.audio || !this.current() || !validAudioSelection(selection, this.audio.audioControlVersion)
      || selection.expectedAudioRevision !== this.audio.audioRevision
      || selection.sources.some(input => !this.audio!.sources.some(s => s.sourceLeaseId === input.sourceLeaseId))) return;
    await this.run(selection);
  }
  private async run(selection: NativeAudioSelection | null): Promise<void> {
    if (this.closed || this.pending) return;
    const context = this.ports.context();
    if (!context) { this.audio = null; this.emit("unavailable"); return; }
    const abort = new AbortController(); this.pending = abort; this.context = context;
    this.lastNow = this.now(); this.audio = null; this.emit("pending");
    const timeout = setTimeout(() => abort.abort(), 5000);
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("native_audio_cancelled"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([this.ports.request(context.program, selection, abort.signal, context.audioControlVersion ?? 1), cancelled]);
      if (this.closed || this.pending !== abort || abort.signal.aborted || !this.current()
        || result.audioControlVersion !== (context.audioControlVersion ?? 1)) throw new Error();
      if (selection === null) {
        if (result.outcome !== "observed" || this.now() >= result.observedAt + 5000) throw new Error();
        this.audio = result; this.emit("ready");
      } else {
        if (result.outcome === "rejected") this.emit("conflict");
        else if (result.outcome !== "applied" || result.audioRevision !== selection.expectedAudioRevision + 1) throw new Error();
        else this.emit("stale"); // Applied receipt is historical, not a current audio snapshot.
      }
    } catch { if (!this.closed && this.pending === abort) { this.audio = null; this.emit("unavailable"); } }
    finally { clearTimeout(timeout); abort.signal.removeEventListener("abort", onAbort); abort.abort(); if (this.pending === abort) this.pending = null; }
  }
  destroy(): void { this.closed = true; this.pending?.abort(); this.pending = null; this.audio = null; this.context = null; }
}
