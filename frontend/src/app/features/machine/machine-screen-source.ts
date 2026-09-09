export interface MachineScreenAuthority {
  readonly sourceId: string; readonly sessionId: string; readonly leaseGeneration: number;
  readonly membershipEpoch: number; readonly expiresAt: number;
}
export interface MachineScreenSurface {
  active(): boolean;
  draw(bitmap: ImageBitmap): void; frame(): void; close(): void;
}
interface ScreenPorts {
  authority(): MachineScreenAuthority;
  create(): MachineScreenSurface;
  decode(bytes: Uint8Array<ArrayBuffer>): Promise<ImageBitmap>;
  clock?: () => number;
  monotonic?: () => number;
}

/** Check dimensions before a decoder allocation. Only bounded baseline RGB JPEG. */
export function screenJpeg(encoded: unknown): Uint8Array<ArrayBuffer> {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > 350_000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("meet_screen_frame_invalid");
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  if (bytes.length > 262_144 || bytes[0] !== 255 || bytes[1] !== 216
    || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error("meet_screen_frame_invalid");
  for (let at = 2; at + 4 < bytes.length;) {
    if (bytes[at++] !== 255) break;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++], length = bytes[at] * 256 + bytes[at + 1];
    if (length < 2 || at + length > bytes.length || marker === 218) break;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (marker !== 192 || length !== 17 || bytes[at + 2] !== 8 || bytes[at + 7] !== 3
        || bytes[at + 3] * 256 + bytes[at + 4] !== 360 || bytes[at + 5] * 256 + bytes[at + 6] !== 640) break;
      return bytes;
    }
    at += length;
  }
  throw new Error("meet_screen_dimensions_invalid");
}

/** A source is derived from verified Hub session identity, never a caller's page ID. */
export class MachineScreenSource {
  private surface: MachineScreenSurface | null = null;
  private scope: MachineScreenAuthority | null = null;
  private generation = 0; private sequence = 0; private lastNow = 0;
  private deadline = 0; private lastFrame = 0; private busy = false;
  // A native decode outlives its source generation and its observation timeout.
  private decoding = false;
  private pendingBytes: Uint8Array<ArrayBuffer> | null = null;
  private error = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clock: () => number;
  private readonly monotonic: () => number;
  constructor(private readonly ports: ScreenPorts) {
    this.clock = ports.clock || Date.now; this.monotonic = ports.monotonic || (() => performance.now());
  }
  open(sourceId: string) {
    this.close();
    this.error = "";
    if (this.decoding) {
      this.error = "decoder_busy";
      throw new Error("meet_screen_decoder_busy");
    }
    const scope = this.ports.authority(), now = this.clock();
    if (sourceId !== scope.sourceId || scope.expiresAt <= now || this.generation >= 1024) throw new Error("meet_screen_source_denied");
    ++this.generation;
    this.scope = Object.freeze({ ...scope }); this.deadline = Math.min(now + 30_000, scope.expiresAt);
    this.lastFrame = this.monotonic(); this.lastNow = now; this.sequence = 0;
    try {
      this.surface = this.ports.create();
      this.check();
      this.timer = setInterval(() => { try { this.check(); } catch { /* Closed by check. */ } }, 100);
      return Object.freeze({ schema: "ananta.meet-screen-source.v1", sourceId, generation: this.generation,
        width: 640, height: 360, fps: 5, expiresAt: this.deadline });
    } catch (error) { this.close(); throw error; }
  }
  private check(): void {
    try {
      const current = this.ports.authority(), now = this.clock(), elapsed = this.monotonic();
      const reason = !this.surface || !this.scope ? "inactive" : now < this.lastNow ? "clock_rollback"
        : this.surface.active() !== true ? "source_ended"
        : now >= this.deadline ? "activation_expired" : elapsed < this.lastFrame ? "clock_rollback"
        : elapsed > this.lastFrame + 2000 ? "frame_stalled"
        : Object.keys(this.scope).some(k => current[k as keyof MachineScreenAuthority] !== this.scope![k as keyof MachineScreenAuthority])
          ? "scope_changed" : "";
      if (reason) {
        this.error ||= reason;
        throw new Error("meet_screen_authority_changed");
      }
      this.lastNow = now;
    } catch { this.error ||= "authority_unavailable"; this.close(); throw new Error("meet_screen_authority_changed"); }
  }
  async push(generation: number, sequence: number, encoded: unknown): Promise<void> {
    this.check();
    if (generation !== this.generation || !Number.isSafeInteger(sequence) || sequence !== this.sequence + 1 || this.busy
      || this.sequence > 0 && this.monotonic() < this.lastFrame + 200) throw new Error("meet_screen_frame_order_invalid");
    const bytes = screenJpeg(encoded); this.busy = true; this.pendingBytes = bytes;
    let bitmap: ImageBitmap | undefined, timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    try {
      const decoding = this.decodeFrame(bytes, () => timedOut);
      bitmap = await Promise.race([decoding, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error("meet_screen_decode_timeout")); }, 1000);
      })]);
      this.check();
      if (generation !== this.generation || bitmap.width !== 640 || bitmap.height !== 360) throw new Error("meet_screen_frame_stale");
      this.surface!.draw(bitmap); this.surface!.frame();
      this.sequence = sequence; this.lastFrame = this.monotonic();
    } catch (error) {
      if (generation === this.generation) {
        this.error ||= error instanceof Error && error.message === "meet_screen_decode_timeout" ? "decode_timeout" : "decode_or_frame_failed";
        this.close();
      }
      throw error;
    }
    finally {
      clearTimeout(timer); bitmap?.close(); bytes.fill(0);
      if (this.pendingBytes === bytes) this.pendingBytes = null;
      if (generation === this.generation) this.busy = false;
    }
  }
  private decodeFrame(bytes: Uint8Array<ArrayBuffer>, timedOut: () => boolean): Promise<ImageBitmap> {
    this.decoding = true;
    try {
      return this.ports.decode(bytes).then(image => {
        this.decoding = false;
        if (timedOut()) image.close();
        return image;
      }, error => {
        this.decoding = false;
        throw error;
      });
    } catch (error) {
      this.decoding = false;
      throw error;
    }
  }
  status() { return Object.freeze({ open: Boolean(this.surface), generation: this.generation, sequence: this.sequence }); }
  diagnostics() { return Object.freeze({ schema: "ananta.meet-screen-diagnostics.v1", lastStopReason: this.error }); }
  close(): void {
    if (!this.scope && !this.surface && !this.busy && !this.timer) return;
    this.error ||= "closed";
    ++this.generation; this.busy = false; this.scope = null;
    const bytes = this.pendingBytes; this.pendingBytes = null; bytes?.fill(0);
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const surface = this.surface; this.surface = null;
    surface?.close();
  }
}
