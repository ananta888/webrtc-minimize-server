export const SPEECH_RATE = 22050;
export const SPEECH_FRAME_SAMPLES = 441;
export const SPEECH_QUEUE_SAMPLES = 4410;

export interface MachineSpeechAuthority {
  readonly sourceId: string; readonly sessionId: string; readonly leaseGeneration: number;
  readonly membershipEpoch: number; readonly expiresAt: number;
}
export interface MachineSpeechGraph {
  push(startSample: number, pcm: ArrayBuffer): void;
  close(): void;
}
interface SpeechPorts {
  authority(): MachineSpeechAuthority;
  create(totalSamples: number, progress: (played: number) => void, failed: () => void, signal: AbortSignal): Promise<MachineSpeechGraph>;
  clock?: () => number; // Absolute epoch time for authority and published expiry.
  monotonicClock?: () => number; // Local elapsed time; never extends authority.
}

export function speechPcm(encoded: unknown): ArrayBuffer {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > 1176
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("meet_speech_pcm_invalid");
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length % 2 || bytes.length > 2 * SPEECH_FRAME_SAMPLES) {
    bytes.fill(0); throw new Error("meet_speech_pcm_invalid");
  }
  return bytes.buffer;
}

/** One source generation; it neither generates speech nor decides who speaks. */
export class MachineSpeechSource {
  private graph: MachineSpeechGraph | null = null;
  private scope: MachineSpeechAuthority | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0; private received = 0; private played = 0; private total = 0;
  private lastNow = 0; private deadline = 0; private lastProgress = 0;
  private lastMonotonic = 0; private localDeadline = 0;
  private state = "closed";
  private readonly clock: () => number;
  private readonly monotonicClock: () => number;
  constructor(private readonly ports: SpeechPorts) {
    this.clock = ports.clock ?? Date.now;
    this.monotonicClock = ports.monotonicClock ?? (() => performance.now());
  }

  async open(sourceId: string, totalSamples: number) {
    this.close();
    const scope = this.ports.authority(), now = this.clock(), local = this.monotonicClock();
    if (!Number.isFinite(now) || !Number.isFinite(local) || local < 0 || !Number.isFinite(scope.expiresAt)
      || sourceId !== scope.sourceId || scope.expiresAt <= now || this.generation >= 2048
      || !Number.isSafeInteger(totalSamples) || totalSamples < 1 || totalSamples > 40 * SPEECH_RATE) {
      throw new Error("meet_speech_source_denied");
    }
    const generation = ++this.generation, controller = new AbortController();
    this.controller = controller; this.scope = Object.freeze({ ...scope });
    this.total = totalSamples; this.received = this.played = 0;
    this.lastNow = now; this.lastMonotonic = this.lastProgress = local; this.localDeadline = local + 50_000;
    this.deadline = Math.min(scope.expiresAt, now + 50_000); this.state = "starting";
    this.timer = setInterval(() => { try { this.check(); } catch { /* check closes its generation */ } }, 100);
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = this.ports.create(totalSamples, played => {
        if (generation !== this.generation) return;
        try {
          this.check();
          if (!Number.isSafeInteger(played) || played <= this.played || played > this.received) throw new Error();
          this.played = played; this.lastProgress = this.lastMonotonic;
          if (played === this.total) this.close("completed");
        } catch { this.close("failed"); }
      }, () => { if (generation === this.generation) this.close("failed"); }, controller.signal)
        .then(graph => { if (controller.signal.aborted || generation !== this.generation) graph.close(); return graph; });
      const graph = await Promise.race([pending, new Promise<never>((_, reject) => {
        setupTimer = setTimeout(() => { controller.abort(); reject(new Error("meet_speech_setup_timeout")); }, 10_000);
        controller.signal.addEventListener("abort", () => reject(new Error("meet_speech_setup_cancelled")), { once: true });
      })]);
      if (generation !== this.generation || controller.signal.aborted) throw new Error("meet_speech_setup_cancelled");
      this.graph = graph; this.check(); this.state = "open"; this.lastProgress = this.lastMonotonic;
      return Object.freeze({ schema: "ananta.meet-speech-source.v1", sourceId, generation, sampleRate: SPEECH_RATE,
        channels: 1, format: "pcm_s16le", totalSamples, queueSamples: SPEECH_QUEUE_SAMPLES, expiresAt: this.deadline });
    } catch (error) { if (generation === this.generation) this.close("failed"); throw error; }
    finally { clearTimeout(setupTimer); }
  }

  private check(): void {
    let cause: string | undefined = "authority-unavailable";
    try {
      const current = this.ports.authority(), now = this.clock(), local = this.monotonicClock();
      cause = !this.scope ? "inactive" : !Number.isFinite(now) || !Number.isFinite(local) ? "clock-invalid"
        : now < this.lastNow || local < this.lastMonotonic ? "clock-backwards"
        : now >= this.deadline || local >= this.localDeadline ? "activation-expired"
        : this.state === "open" && local >= this.lastProgress + 2000 ? "progress-expired" : undefined;
      if (!cause) {
        const changed = Object.keys(this.scope!).find(k => current[k as keyof MachineSpeechAuthority] !== this.scope![k as keyof MachineSpeechAuthority]);
        if (changed) cause = ["sourceId", "sessionId", "leaseGeneration", "membershipEpoch", "expiresAt"].includes(changed) ? changed : "scope";
      }
      if (!cause) { this.lastNow = now; this.lastMonotonic = local; return; }
    } catch { cause = "authority-unavailable"; }
    this.close("failed"); throw new Error("meet_speech_authority_changed", { cause });
  }

  push(generation: number, startSample: number, encoded: unknown): void {
    this.check();
    if (generation !== this.generation) throw new Error("meet_speech_frame_stale");
    if (!this.graph || this.state !== "open" || !Number.isSafeInteger(startSample) || startSample !== this.received) {
      this.close("failed"); throw new Error("meet_speech_frame_order_invalid");
    }
    let pcm: ArrayBuffer;
    try { pcm = speechPcm(encoded); }
    catch { this.close("failed"); throw new Error("meet_speech_pcm_invalid"); }
    const samples = pcm.byteLength / 2;
    if (samples !== Math.min(SPEECH_FRAME_SAMPLES, this.total - this.received)) {
      new Uint8Array(pcm).fill(0); this.close("failed"); throw new Error("meet_speech_frame_size_invalid");
    }
    if (this.received + samples > this.total || this.received - this.played + samples > SPEECH_QUEUE_SAMPLES) {
      new Uint8Array(pcm).fill(0); this.close("failed"); throw new Error("meet_speech_buffer_exceeded");
    }
    this.received += samples;
    try { this.graph.push(startSample, pcm); }
    catch { if (pcm.byteLength) new Uint8Array(pcm).fill(0); this.close("failed"); throw new Error("meet_speech_graph_failed"); }
  }

  status() {
    if (this.scope) { try { this.check(); } catch { /* Report closed status. */ } }
    return Object.freeze({ state: this.state, generation: this.generation, receivedSamples: this.received,
      playedSamples: this.played, bufferedSamples: this.graph ? this.received - this.played : 0 });
  }

  close(state = "closed"): void {
    if (!this.scope && !this.controller && !this.graph && !this.timer) return;
    ++this.generation; this.scope = null; this.state = state;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const controller = this.controller, graph = this.graph;
    this.controller = null; this.graph = null;
    controller?.abort(); graph?.close();
  }
}
