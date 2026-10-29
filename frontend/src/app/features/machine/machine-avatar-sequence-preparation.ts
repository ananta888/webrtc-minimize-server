import { AvatarSequenceContent } from "./machine-avatar-sequence-contract";
import { AvatarVideoContent } from "./machine-avatar-video-contract";

export interface PreparedAvatarFrame {
  draw(drawing: CanvasRenderingContext2D): void;
  close(): void;
}
export interface SequenceFrameDecoder {
  frame(index: number, signal: AbortSignal): Promise<PreparedAvatarFrame>;
  close(): void;
}
interface PreparationPorts {
  digest(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  decode(content: AvatarVideoContent, signal: AbortSignal): Promise<SequenceFrameDecoder>;
  clock?: () => number;
}
export interface PreparedAvatarSequence {
  draw(clip: number, frame: number, drawing: CanvasRenderingContext2D): void;
  close(): void;
}
export interface AvatarSequencePreparationPort {
  prepare(content: AvatarSequenceContent, check: () => void, caller: AbortSignal): Promise<PreparedAvatarSequence>;
}
export const AVATAR_SEQUENCE_PREPARATION_MS = 20_000;
const release = (action: () => void) => { try { action(); } catch { /* Continue releasing every owned resource. */ } };

async function receiveOwned<T>(start: () => Promise<T>, signal: AbortSignal, dispose: (value: T) => void,
  settled: () => void = () => {}): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  try {
    const operation = start().then(value => {
      try { if (signal.aborted) release(() => dispose(value)); return value; }
      finally { settled(); }
    }, error => { settled(); throw error; });
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      stop = () => reject(new Error("meet_avatar_sequence_preparation_cancelled"));
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    })]);
  } finally { signal.removeEventListener("abort", stop); }
}

/** One frame atlas lifetime and one decoder at a time; no publication or authority issuer. */
export class AvatarSequencePreparation implements AvatarSequencePreparationPort {
  private owned = false;
  private pending = 0;
  private releasing = false;
  constructor(private readonly ports: PreparationPorts) {}

  private releasePermit(): void {
    if (this.releasing && this.pending === 0) this.owned = false;
  }

  private receive<T>(start: () => Promise<T>, signal: AbortSignal, dispose: (value: T) => void): Promise<T> {
    const settled = () => { this.pending--; this.releasePermit(); };
    return receiveOwned(() => {
      this.pending++;
      try { return start(); } catch (error) { settled(); throw error; }
    }, signal, dispose, settled);
  }

  async prepare(content: AvatarSequenceContent, check: () => void, caller: AbortSignal): Promise<PreparedAvatarSequence> {
    if (this.owned) throw new Error("meet_avatar_sequence_preparation_busy");
    this.owned = true; this.releasing = false;
    const controller = new AbortController(), clock = this.ports.clock ?? (() => performance.now());
    const started = clock(), frames: PreparedAvatarFrame[][] = [];
    let decoder: SequenceFrameDecoder | undefined;
    let closePrepared: (() => void) | undefined;
    const stop = () => { controller.abort(); closePrepared?.(); };
    caller.addEventListener("abort", stop, { once: true });
    if (caller.aborted) stop();
    const timer = setTimeout(stop, AVATAR_SEQUENCE_PREPARATION_MS);
    let previous = started;
    const current = () => {
      controller.signal.throwIfAborted();
      const now = clock();
      if (!Number.isFinite(started) || started < 0 || !Number.isFinite(now)
        || now < previous || now >= started + AVATAR_SEQUENCE_PREPARATION_MS) {
        throw new Error("meet_avatar_sequence_preparation_expired");
      }
      previous = now; check();
    };
    const closeFrames = () => {
      for (const clip of frames) for (const frame of clip) release(() => frame.close());
      frames.length = 0;
    };
    try {
      current();
      for (const clip of content.clips) {
        const digest = await receiveOwned(() => this.ports.digest(clip.content.bytes), controller.signal, () => {});
        current();
        if (digest !== clip.content.sha256) throw new Error("meet_avatar_sequence_digest_invalid");
        decoder = await this.receive(() => this.ports.decode(clip.content, controller.signal),
          controller.signal, owned => owned.close());
        const target: PreparedAvatarFrame[] = []; frames.push(target);
        current();
        for (let index = 0; index < clip.content.frames; index++) {
          current();
          const frame = await this.receive(() => decoder!.frame(index, controller.signal),
            controller.signal, owned => owned.close());
          target.push(frame); current();
        }
        const completed = decoder; decoder = undefined; completed.close();
      }
      let closed = false;
      closePrepared = () => {
        if (closed) return; closed = true;
        caller.removeEventListener("abort", stop);
        closeFrames(); this.releasing = true; this.releasePermit();
      };
      return { draw: (clip, frame, drawing) => {
        if (closed || !Number.isSafeInteger(clip) || !Number.isSafeInteger(frame) || !frames[clip]?.[frame]) {
          throw new Error("meet_avatar_sequence_frame_invalid");
        }
        frames[clip][frame].draw(drawing);
      }, close: closePrepared };
    } catch (error) {
      release(() => decoder?.close()); closeFrames(); this.releasing = true; this.releasePermit(); throw error;
    } finally {
      clearTimeout(timer);
      if (!closePrepared) caller.removeEventListener("abort", stop);
      for (const clip of content.clips) clip.content.bytes.fill(0);
    }
  }
}
