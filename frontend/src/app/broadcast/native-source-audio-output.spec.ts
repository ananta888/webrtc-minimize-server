import { expect, it } from "vitest";
import { normalizeSourceAudioOutput } from "./native-source-audio-output";
import { supportsSourceAudioOutput } from "./native-source-audio-capability";
const selected = { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 };
it("copies exact output choices and bounds mono separately from stereo", () => {
  const input = { ...selected }, output = normalizeSourceAudioOutput(input);
  input.channels = 2; expect(output).toEqual(selected); expect(Object.isFrozen(output)).toBe(true);
  for (const channels of [1, 2]) for (const targetBitsPerSecond of [16000, channels === 1 ? 192000 : 320000]) {
    expect(normalizeSourceAudioOutput({ ...selected, channels, targetBitsPerSecond }).targetBitsPerSecond).toBe(targetBitsPerSecond);
  }
  for (const patch of [{ codec: "opus" }, { sampleRate: 44100 }, { channels: 3 }, { channels: true },
    { targetBitsPerSecond: 192001 }, { targetBitsPerSecond: 15999 }, { targetBitsPerSecond: 48000.5 },
    { targetBitsPerSecond: Infinity }, { targetBitsPerSecond: "48000" }, { extra: true }]) {
    expect(() => normalizeSourceAudioOutput({ ...selected, ...patch })).toThrow();
  }
  for (const value of [null, undefined, [], {}]) expect(() => normalizeSourceAudioOutput(value)).toThrow();
  for (const key of Object.keys(selected)) {
    const value = { ...selected }; Reflect.deleteProperty(value, key);
    expect(() => normalizeSourceAudioOutput(value)).toThrow();
  }
});
it("requires all negotiated capability fields; no inference from agent version", () => {
  const capability = { capabilityVersion: 5, sourcePrograms: true, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1 };
  expect(supportsSourceAudioOutput(capability)).toBe(true);
  for (const key of Object.keys(capability)) {
    const value = { ...capability }; Reflect.deleteProperty(value, key);
    expect(supportsSourceAudioOutput(value)).toBe(false);
  }
  for (const patch of [{ capabilityVersion: 6 }, { sourceAudioControlVersion: 2 }, { sourceAudioEncodingVersion: 2 }, { sourcePrograms: false }]) {
    expect(supportsSourceAudioOutput({ ...capability, ...patch })).toBe(false);
  }
});
