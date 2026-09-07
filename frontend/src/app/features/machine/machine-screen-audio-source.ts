import { MachineScreenAuthority } from "./machine-screen-source";

export interface ScreenAudioAuthority extends MachineScreenAuthority { readonly screenGeneration: number }
export interface ScreenAudioSink { write(samples: Float32Array<ArrayBuffer>): void; close(): void }
interface Ports {
  authority(): ScreenAudioAuthority;
  create(signal: AbortSignal): Promise<ScreenAudioSink>;
  clock?: () => number;
  monotonic?: () => number;
}

/** Explicit synthetic PCM input, bound to the current owned screen activation. */
export class MachineScreenAudioSource {
  private sink: ScreenAudioSink | null = null;
  private scope: ScreenAudioAuthority | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0; private sequence = 0; private lastNow = 0; private lastChunk = 0; private deadline = 0;
  private readonly clock: () => number;
  private readonly monotonic: () => number;
  constructor(private readonly ports: Ports) {
    this.clock = ports.clock || Date.now; this.monotonic = ports.monotonic || (() => performance.now());
  }
  async open(sourceId: string) {
    this.close();
    const scope = this.ports.authority(), now = this.clock();
    if (sourceId !== scope.sourceId || scope.expiresAt <= now || this.generation >= 1024) throw new Error("meet_screen_audio_denied");
    const generation = ++this.generation, controller = new AbortController();
    this.scope = { ...scope }; this.controller = controller; this.sequence = 0;
    this.lastNow = now; this.lastChunk = this.monotonic(); this.deadline = Math.min(now + 30_000, scope.expiresAt);
    this.timer = setInterval(() => { try { this.check(); } catch { /* Already closed. */ } }, 100);
    let abort = () => {};
    try {
      const creation = this.ports.create(controller.signal).then(sink => {
        if (controller.signal.aborted) { sink.close(); throw new Error("meet_screen_audio_cancelled"); }
        return sink;
      });
      const sink = await Promise.race([creation, new Promise<never>((_, reject) => {
        abort = () => reject(new Error("meet_screen_audio_cancelled"));
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      })]);
      if (this.generation !== generation || controller.signal.aborted) { sink.close(); throw new Error("meet_screen_audio_cancelled"); }
      this.sink = sink; this.check();
      return Object.freeze({ schema: "ananta.meet-screen-audio-source.v1", sourceId, generation,
        sampleRate: 48000, channels: 1, format: "pcm_s16le", chunkSamples: 4800, expiresAt: this.deadline });
    } catch (error) { if (this.generation === generation) this.close(); throw error; }
    finally { controller.signal.removeEventListener("abort", abort); }
  }
  private check(): void {
    try {
      const now = this.clock(), elapsed = this.monotonic(), authority = this.ports.authority();
      if (!this.scope || !this.controller || this.controller.signal.aborted || now < this.lastNow
        || now >= this.deadline || elapsed < this.lastChunk || elapsed > this.lastChunk + 1000
        || Object.keys(this.scope).some(k => authority[k as keyof ScreenAudioAuthority] !== this.scope![k as keyof ScreenAudioAuthority])) {
        throw new Error("meet_screen_audio_authority_changed");
      }
      this.lastNow = now;
    } catch { this.close(); throw new Error("meet_screen_audio_authority_changed"); }
  }
  push(generation: number, sequence: number, encoded: unknown): void {
    // Late packets do not revoke an independently reauthorized source.
    if (generation !== this.generation) throw new Error("meet_screen_audio_stale");
    this.check();
    let bytes: Uint8Array | undefined, samples: Float32Array<ArrayBuffer> | undefined;
    try {
      if (!this.sink || !Number.isSafeInteger(sequence) || sequence !== this.sequence + 1 || sequence > 300
        || typeof encoded !== "string" || encoded.length !== 12800 || !/^[A-Za-z0-9+/]+$/.test(encoded)) {
        throw new Error("meet_screen_audio_chunk_invalid");
      }
      bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      if (bytes.length !== 9600) throw new Error("meet_screen_audio_chunk_invalid");
      const view = new DataView(bytes.buffer); samples = new Float32Array(4800);
      for (let i = 0; i < 4800; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      this.sink.write(samples); this.sequence = sequence; this.lastChunk = this.monotonic();
    } catch (error) { this.close(); throw error; }
    finally { bytes?.fill(0); samples?.fill(0); }
  }
  status() { return Object.freeze({ open: Boolean(this.sink), generation: this.generation, sequence: this.sequence }); }
  close(): void {
    if (!this.controller && !this.sink && !this.timer) return;
    ++this.generation;
    const controller = this.controller, sink = this.sink;
    this.controller = null; this.sink = null; this.scope = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    controller?.abort(); sink?.close();
  }
}
