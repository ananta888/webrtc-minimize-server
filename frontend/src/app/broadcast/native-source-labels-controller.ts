import { NativeSceneState } from "./native-source-scene-contract";
import { NativeSourceLabels, parseNativeSourceLabels } from "./native-source-labels-contract";

export interface NativeSourceLabelsView {
  readonly phase: "idle" | "pending" | "ready" | "unavailable";
  readonly labels: NativeSourceLabels | null;
}
interface Ports {
  owner(): string | null;
  scene(): NativeSceneState | null;
  request(scene: NativeSceneState, signal: AbortSignal): Promise<NativeSourceLabels>;
  changed(value: NativeSourceLabelsView): void;
  clock?: () => number;
}
/** Optional display metadata, never scene authority. No polling fetches, retries, storage or names. */
export class NativeSourceLabelsController {
  private owner: string | null = null;
  private scene: NativeSceneState | null = null;
  private pending: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastNow = 0;
  constructor(private readonly ports: Ports) {}
  private emit(phase: NativeSourceLabelsView["phase"], labels: NativeSourceLabels | null = null): void {
    this.ports.changed(Object.freeze({ phase, labels }));
  }
  private current(): boolean {
    const now = (this.ports.clock ?? Date.now)();
    const valid = Number.isSafeInteger(now) && now > 0 && now >= this.lastNow && !!this.owner
      && this.owner === this.ports.owner() && !!this.scene && this.scene === this.ports.scene()
      && this.scene.observedAt <= now + 1000 && now < this.scene.observedAt + 5000;
    this.lastNow = now;
    return !!valid;
  }
  private cancel(): void {
    this.pending?.abort(); this.pending = null;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }
  clear(): void { this.cancel(); this.owner = null; this.scene = null; this.emit("idle"); }
  tick(): void { if (!this.closed && this.scene && !this.current()) this.clear(); }
  observe(scene: NativeSceneState | null): void {
    this.clear();
    if (this.closed || !scene) return;
    this.owner = this.ports.owner(); this.scene = scene;
    if (!this.current()) { this.clear(); return; }
    if (scene.availableSources.length === 0) { this.emit("ready"); return; }
    const abort = new AbortController(); this.pending = abort; this.emit("pending");
    this.timeout = setTimeout(() => {
      if (this.pending !== abort) return;
      this.cancel(); this.emit("unavailable");
    }, 3000);
    // Bound the UI wait even if an injected transport ignores abort.
    void Promise.resolve().then(() => {
      if (abort.signal.aborted || !this.current()) throw new Error();
      return this.ports.request(scene, abort.signal);
    }).then(value => {
      if (this.closed || this.pending !== abort || abort.signal.aborted) return;
      if (!this.current()) { this.clear(); return; }
      const labels = parseNativeSourceLabels(value, scene);
      this.cancel(); this.emit("ready", labels);
    }).catch(() => {
      if (!this.closed && this.pending === abort) { this.cancel(); this.emit("unavailable"); }
    });
  }
  destroy(): void { this.closed = true; this.clear(); }
}
