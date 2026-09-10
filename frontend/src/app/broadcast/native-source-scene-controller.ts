import { NativeSceneResult, NativeSceneSelection, NativeSceneState, validSceneSelection } from "./native-source-scene-contract";
import { BroadcastProgramRef } from "./broadcast-ports";

export interface NativeSceneContext { readonly key: string; readonly program: BroadcastProgramRef }
export interface NativeSceneView { readonly phase: "idle" | "pending" | "ready" | "stale" | "conflict" | "unavailable"; readonly scene: NativeSceneState | null }
interface Ports {
  context(): NativeSceneContext | null;
  request(program: BroadcastProgramRef, selection: NativeSceneSelection | null, signal: AbortSignal): Promise<NativeSceneResult>;
  changed(value: NativeSceneView): void;
  clock?: () => number;
}
const same = (a: NativeSceneContext | null, b: NativeSceneContext | null) => a && b && a.key === b.key
  && a.program.programId === b.program.programId && a.program.programRevision === b.program.programRevision && a.program.programEpoch === b.program.programEpoch;

/** No capture/consent/publication ownership. A timed-out apply is uncertain, never retried. */
export class NativeSourceSceneController {
  private scene: NativeSceneState | null = null;
  private context: NativeSceneContext | null = null;
  private pending: AbortController | null = null;
  private closed = false;
  private lastNow = 0;
  private readonly now: () => number;
  constructor(private readonly ports: Ports) { this.now = ports.clock || Date.now; }
  private emit(phase: NativeSceneView["phase"]): void { this.ports.changed(Object.freeze({ phase, scene: this.scene })); }
  private current(): boolean {
    const now = this.now(), valid = Number.isSafeInteger(now) && now >= this.lastNow && same(this.context, this.ports.context());
    this.lastNow = now;
    return !!valid;
  }
  tick(): void {
    if (this.closed) return;
    if (this.context && (!this.current() || this.scene && this.now() >= this.scene.observedAt + 5000)) {
      this.pending?.abort(); this.pending = null; this.scene = null; this.context = null; this.emit("stale");
    }
  }
  async refresh(): Promise<void> { await this.run(null); }
  async apply(selection: NativeSceneSelection, trigger: unknown): Promise<void> {
    this.tick();
    if (trigger !== "user-action" || !this.scene || !this.current() || !validSceneSelection(selection)
      || selection.expectedSceneRevision !== this.scene.sceneRevision
      || (this.scene.sceneControlVersion === 2) !== (selection.sourceFits !== undefined)
      || selection.sourceLeaseIds.some(id => !this.scene!.availableSources.some(s => s.sourceLeaseId === id))) return;
    await this.run(selection);
  }
  private async run(selection: NativeSceneSelection | null): Promise<void> {
    if (this.closed || this.pending) return;
    const context = this.ports.context();
    if (!context) { this.scene = null; this.emit("unavailable"); return; }
    const abort = new AbortController(); this.pending = abort; this.context = context;
    this.lastNow = this.now(); this.scene = null; this.emit("pending");
    const timeout = setTimeout(() => abort.abort(), 5000);
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("native_scene_cancelled"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([this.ports.request(context.program, selection, abort.signal), cancelled]);
      if (this.closed || this.pending !== abort || abort.signal.aborted || !this.current()) throw new Error();
      if (selection === null) {
        if (result.outcome !== "observed") throw new Error();
        this.scene = result; this.emit("ready");
      } else {
        if (result.sceneControlVersion !== (selection.sourceFits === undefined ? 1 : 2)) throw new Error();
        if (result.outcome === "rejected") this.emit("conflict");
        else if (result.outcome !== "applied" || result.sceneRevision !== selection.expectedSceneRevision + 1
          || result.sceneControlVersion !== (selection.sourceFits === undefined ? 1 : 2)) throw new Error();
        else this.emit("stale"); // Applied receipt is historical, not a current scene snapshot.
      }
    } catch { if (!this.closed && this.pending === abort) { this.scene = null; this.emit("unavailable"); } }
    finally { clearTimeout(timeout); abort.signal.removeEventListener("abort", onAbort); abort.abort(); if (this.pending === abort) this.pending = null; }
  }
  destroy(): void { this.closed = true; this.pending?.abort(); this.pending = null; this.scene = null; this.context = null; }
}
