import { AvatarSequenceContent, AVATAR_SEQUENCE_FPS } from "./machine-avatar-sequence-contract";
import { SPEECH_RATE, SPEECH_QUEUE_SAMPLES } from "./machine-speech-format";

export interface SequenceFramePosition {
  readonly clipIndex: number;
  readonly frameIndex: number;
  readonly playedSamples: number;
  readonly frameStartSample: number;
  readonly frameEndSample: number;
  readonly held: boolean;
}

/** Execution quality only. Progress never grants membership, source rights or extra time. */
export class AvatarSequenceClock {
  private previousPlayed = 0;
  private previousReceived = 0;
  private completed = false;
  private opened = false;
  private retired = false;
  constructor(private readonly content: AvatarSequenceContent, private readonly speechGeneration: number) {
    if (!Number.isSafeInteger(speechGeneration) || speechGeneration < 1 || speechGeneration > 2048) {
      throw new Error("meet_avatar_sequence_generation_invalid");
    }
  }

  read(value: unknown): SequenceFramePosition {
    try {
      if (this.retired || !value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "bufferedSamples,generation,playedSamples,receivedSamples,state") {
        throw new Error();
      }
      const row = value as Record<string, unknown>;
      const { generation, playedSamples: played, receivedSamples: received, bufferedSamples: buffered, state } = row;
      if (![generation, played, received, buffered].every(v => typeof v === "number" && Number.isSafeInteger(v))) {
        throw new Error();
      }
      const terminal = state === "completed";
      if ((played as number) < this.previousPlayed || (received as number) < this.previousReceived
        || (played as number) > (received as number) || (received as number) > this.content.totalSamples
        || (buffered as number) < 0 || (buffered as number) > SPEECH_QUEUE_SAMPLES
        || (terminal ? !this.opened || generation !== this.speechGeneration + 1
          || played !== this.content.totalSamples || received !== played || buffered !== 0
          : (state !== "starting" && state !== "open") || generation !== this.speechGeneration
            || buffered !== (received as number) - (played as number))
        || this.completed && !terminal || this.opened && state === "starting") throw new Error();
      this.previousPlayed = played as number; this.previousReceived = received as number; this.completed = terminal;
      this.opened ||= state === "open";
      const position = Math.min(this.content.totalSamples - 1, played as number);
      const clipIndex = this.content.clips.findIndex(clip => position < clip.endSample);
      const clip = this.content.clips[clipIndex];
      const frameIndex = Math.min(clip.content.frames - 1,
        Math.floor((position - clip.startSample) * AVATAR_SEQUENCE_FPS / SPEECH_RATE));
      return Object.freeze({ clipIndex, frameIndex, playedSamples: played as number,
        frameStartSample: clip.startSample + Math.floor(frameIndex * SPEECH_RATE / AVATAR_SEQUENCE_FPS),
        frameEndSample: Math.min(clip.endSample,
          clip.startSample + Math.floor((frameIndex + 1) * SPEECH_RATE / AVATAR_SEQUENCE_FPS)), held: terminal });
    } catch {
      this.retired = true;
      throw new Error("meet_avatar_sequence_progress_invalid");
    }
  }
}
