/** AAC output selection, independent of the room's Opus and the video ladder. */
export interface NativeSourceAudioOutput {
  readonly codec: "aac"; readonly sampleRate: 48000; readonly channels: 1 | 2; readonly targetBitsPerSecond: number;
}
export function normalizeSourceAudioOutput(value: unknown): NativeSourceAudioOutput {
  const v = value as NativeSourceAudioOutput;
  if (!v || typeof v !== "object" || Array.isArray(v)
    || Object.keys(v).sort().join() !== "channels,codec,sampleRate,targetBitsPerSecond"
    || v.codec !== "aac" || v.sampleRate !== 48000 || ![1, 2].includes(v.channels)
    || !Number.isSafeInteger(v.targetBitsPerSecond) || v.targetBitsPerSecond < 16000
    || v.targetBitsPerSecond > (v.channels === 1 ? 192000 : 320000)) {
    throw new Error("invalid_native_source_audio_output");
  }
  return Object.freeze({ codec: "aac", sampleRate: 48000, channels: v.channels, targetBitsPerSecond: v.targetBitsPerSecond });
}
