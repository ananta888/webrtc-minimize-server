/** Presentation selection only. Admission, ownership and capabilities are separate. */
export function normalizeNativeSourceAudioOutput(value) {
  const fields = ["codec", "sampleRate", "channels", "targetBitsPerSecond"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.codec !== "aac" || value.sampleRate !== 48000 || ![1, 2].includes(value.channels)
    || !Number.isSafeInteger(value.targetBitsPerSecond) || value.targetBitsPerSecond < 16000
    || value.targetBitsPerSecond > (value.channels === 1 ? 192000 : 320000)) {
    throw new Error("invalid_native_source_audio_output");
  }
  return Object.freeze({ codec: "aac", sampleRate: 48000, channels: value.channels, targetBitsPerSecond: value.targetBitsPerSecond });
}
