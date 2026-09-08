import { describe, expect, it } from "vitest";
import { wipeMachinePcm } from "./machine-pcm-buffer";

describe("owned machine PCM wipe", () => {
  it("clears all bytes and is idempotent", () => {
    const bytes = new Uint8Array(3200).fill(123);
    wipeMachinePcm(bytes.buffer); wipeMachinePcm(bytes.buffer);
    expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it("does not coerce non-buffer values or modify unowned views", () => {
    const bytes = new Uint8Array(8).fill(7);
    for (const value of [null, undefined, "pcm", bytes, { valueOf() { throw new Error("no coercion"); } }]) {
      expect(() => wipeMachinePcm(value)).not.toThrow();
    }
    expect([...bytes]).toEqual(Array(8).fill(7));
  });
  it("does not break cleanup for a buffer already transferred to another owner", () => {
    const buffer = new ArrayBuffer(3200); new Uint8Array(buffer).fill(123);
    const transferred = structuredClone(buffer, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0);
    expect(() => wipeMachinePcm(buffer)).not.toThrow();
    expect(new Uint8Array(transferred).every(byte => byte === 123)).toBe(true);
    new Uint8Array(transferred).fill(0);
  });
});
