import { AvatarVideoContent, parseAvatarVideo } from "./machine-avatar-video-contract";
import { SPEECH_RATE } from "./machine-speech-format";

export const AVATAR_SEQUENCE_FPS = 12;
export const AVATAR_SEQUENCE_MAX_FRAMES = 480;
export const AVATAR_SEQUENCE_MAX_DECODED_BYTES = 128 * 1024 * 1024;
export interface AvatarSequenceClip {
  readonly startSample: number;
  readonly endSample: number;
  readonly content: AvatarVideoContent;
}
export interface AvatarSequenceContent {
  readonly totalSamples: number;
  readonly clips: readonly AvatarSequenceClip[];
}

function fields(value: unknown, expected: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== expected) throw new Error("meet_avatar_sequence_invalid");
  return value as Record<string, unknown>;
}
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;

/** Shape/size validation only. Preparation must verify each digest before rendering. */
export function parseAvatarSequence(value: unknown): AvatarSequenceContent {
  const request = fields(value, "clips,schema,totalSamples");
  if (request["schema"] !== "ananta.meet-avatar-sequence.v1"
    || !integer(request["totalSamples"], 40 * SPEECH_RATE) || !request["totalSamples"]
    || !Array.isArray(request["clips"]) || !request["clips"].length || request["clips"].length > 5) {
    throw new Error("meet_avatar_sequence_invalid");
  }
  const clips: AvatarSequenceClip[] = [];
  let cursor = 0, frames = 0;
  try {
    for (const value of request["clips"]) {
      const row = fields(value, "content,endSample,startSample");
      if (!integer(row["startSample"], request["totalSamples"])
        || !integer(row["endSample"], request["totalSamples"])
        || row["startSample"] !== cursor || row["endSample"] <= cursor) throw new Error("meet_avatar_sequence_invalid");
      const content = Object.freeze(parseAvatarVideo(row["content"]));
      clips.push(Object.freeze({ startSample: cursor, endSample: row["endSample"], content }));
      const expected = Math.max(2, Math.ceil((row["endSample"] - cursor) * AVATAR_SEQUENCE_FPS / SPEECH_RATE));
      frames += content.frames;
      if (content.repeatMode !== "hold_last" || content.frames !== expected
        || frames > AVATAR_SEQUENCE_MAX_FRAMES || frames * 256 * 256 * 4 > AVATAR_SEQUENCE_MAX_DECODED_BYTES) {
        throw new Error("meet_avatar_sequence_invalid");
      }
      cursor = row["endSample"];
    }
    if (cursor !== request["totalSamples"]) throw new Error("meet_avatar_sequence_invalid");
    return Object.freeze({ totalSamples: cursor, clips: Object.freeze(clips) });
  } catch (error) {
    for (const clip of clips) clip.content.bytes.fill(0);
    throw error;
  }
}
