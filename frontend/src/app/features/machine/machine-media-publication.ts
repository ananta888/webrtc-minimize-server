export type MachineMediaOutput = "avatar" | "speech";
export interface MachineMediaAuthority {
  readonly sessionId: string; readonly generation: number; readonly expiresAt: number;
  readonly avatar: boolean; readonly speech: boolean;
}
export interface MachineMediaHandle {
  ready(): boolean;
  metadata(): { duration: number; width: number; height: number };
  attach(outputs: readonly MachineMediaOutput[]): void;
  play(): Promise<void>;
  ended(): boolean;
  failed(): boolean;
  close(): void;
}
interface Ports {
  authority(): MachineMediaAuthority;
  create(bytes: Uint8Array<ArrayBuffer>, outputs: readonly MachineMediaOutput[]): MachineMediaHandle;
  transportReady(): boolean;
  clock?: () => number;
  monotonic?: () => number;
}
interface Operation {
  readonly controller: AbortController; readonly authority: MachineMediaAuthority;
  readonly outputs: readonly MachineMediaOutput[];
  handle: MachineMediaHandle | null; lastNow: number;
}

/** One bounded synthetic MP4 writer. Never owns human capture or the screen source. */
export class MachineMediaPublication {
  private operation: Operation | null = null;
  private readonly clock: () => number;
  private readonly monotonic: () => number;
  constructor(private readonly ports: Ports) {
    this.clock = ports.clock || Date.now; this.monotonic = ports.monotonic || (() => performance.now());
  }
  async publish(encoded: unknown, outputs: unknown, onReady?: () => void): Promise<void> {
    if (this.operation) throw new Error("machine_media_busy");
    if (!Array.isArray(outputs) || !outputs.length || outputs.length > 2 || new Set(outputs).size !== outputs.length
      || outputs.some(value => value !== "avatar" && value !== "speech") || typeof encoded !== "string"
      || !encoded.length || encoded.length > 4_700_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error("machine_media_request_invalid");
    }
    const authority = this.ports.authority(), now = this.clock();
    if (authority.expiresAt <= now || outputs.some((output: MachineMediaOutput) => !authority[output])) throw new Error("machine_media_denied");
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") { bytes.fill(0); throw new Error("machine_media_invalid"); }
    const operation: Operation = { controller: new AbortController(), authority: { ...authority }, outputs: [...outputs],
      handle: null, lastNow: now };
    this.operation = operation;
    try {
      operation.handle = this.ports.create(bytes, operation.outputs);
      await this.until(operation, () => operation.handle!.ready(), 20_000);
      const meta = operation.handle.metadata();
      if (!Number.isFinite(meta.duration) || meta.duration <= 0 || meta.duration > 40
        || !Number.isInteger(meta.width) || !Number.isInteger(meta.height)
        || meta.width < 0 || meta.height < 0 || meta.width > 1280 || meta.height > 720
        || operation.outputs.includes("avatar") && (meta.width < 1 || meta.height < 1)) {
        throw new Error("machine_media_metadata_invalid");
      }
      operation.handle.attach(operation.outputs);
      await this.until(operation, () => this.ports.transportReady(), 20_000);
      this.check(operation); onReady?.();
      // A stuck play() cannot outlive cancellation, authority or the playback budget.
      let started = false, failed = false;
      void operation.handle.play().then(() => { started = true; }, () => { failed = true; });
      await this.until(operation, () => {
        if (failed) throw new Error("machine_media_play_failed");
        return started && operation.handle!.ended();
      }, 45_000);
    } finally {
      bytes.fill(0);
      if (this.operation === operation) this.close();
    }
  }
  private check(operation: Operation): void {
    if (this.operation !== operation || operation.controller.signal.aborted) throw new Error("machine_media_cancelled");
    const current = this.ports.authority(), now = this.clock();
    if (now < operation.lastNow || now >= current.expiresAt || current.sessionId !== operation.authority.sessionId
      || current.generation !== operation.authority.generation || operation.outputs.some(output => !current[output])) {
      throw new Error("machine_media_authority_changed");
    }
    if (operation.handle?.failed()) throw new Error("machine_media_decode_failed");
    operation.lastNow = now;
  }
  private async until(operation: Operation, ready: () => boolean, budget: number): Promise<void> {
    const started = this.monotonic(), deadline = started + budget;
    for (;;) {
      this.check(operation);
      if (this.monotonic() < started || this.monotonic() >= deadline) throw new Error("machine_media_timeout");
      if (ready()) return;
      await new Promise<void>(resolve => {
        const signal = operation.controller.signal;
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 50);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
  status() { return Object.freeze({ active: Boolean(this.operation), outputs: Object.freeze([...(this.operation?.outputs || [])]) }); }
  close(): void {
    const operation = this.operation;
    if (!operation) return;
    this.operation = null; operation.controller.abort();
    operation.handle?.close(); operation.handle = null;
  }
}
