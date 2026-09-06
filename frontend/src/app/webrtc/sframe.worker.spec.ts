import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ set: vi.fn(), remove: vi.fn(), destroy: vi.fn() }));
vi.mock("./sframe-codec", () => ({
  SFrameError: class extends Error { constructor(readonly code: string) { super(code); } },
  SFrameEncryptContext: class { destroy = mocks.destroy; },
  SFrameDecryptContext: class { setKey = mocks.set; removeKey = mocks.remove; destroy = mocks.destroy; },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });
it("retains eight overlapping decrypt keys and does not reset replay state for duplicates", async () => {
  const listeners = new Map<string, (event: object) => void>();
  vi.stubGlobal("addEventListener", (name: string, listener: (event: object) => void) => listeners.set(name, listener));
  await import("./sframe.worker");
  const send = (id: number) => listeners.get("message")!({ data: { version: 1, type: "set-key", direction: "decrypt",
    contextId: "in:publication:peer", keyId: id.toString(16).padStart(16, "0"), baseKey: new ArrayBuffer(16) } });
  for (let i = 0; i < 10; i++) send(i);
  expect(mocks.set).toHaveBeenCalledTimes(10);
  expect(mocks.remove.mock.calls).toEqual([[0n], [1n]]);
  send(9); expect(mocks.set).toHaveBeenCalledTimes(10);
  send(0); send(1); expect(mocks.set).toHaveBeenCalledTimes(10);
  listeners.get("message")!({ data: { version: 1, type: "clear-context", contextId: "in:publication:peer" } });
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
it("does not reset sender nonce state for repeated or retired KIDs and bounds key history", async () => {
  const listeners = new Map<string, (event: object) => void>(), post = vi.fn();
  vi.stubGlobal("postMessage", post);
  vi.stubGlobal("addEventListener", (name: string, listener: (event: object) => void) => listeners.set(name, listener));
  await import("./sframe.worker");
  const send = (id: number) => {
    const baseKey = new Uint8Array(16).fill(42);
    listeners.get("message")!({ data: { version: 1, type: "set-key", direction: "encrypt", contextId: "out:audio:peer",
      keyId: id.toString(16).padStart(16, "0"), baseKey: baseKey.buffer } });
    expect(baseKey.every(n => n === 0)).toBe(true);
  };
  send(0); send(0); expect(mocks.destroy).not.toHaveBeenCalled();
  send(1); send(0); expect(mocks.destroy).toHaveBeenCalledTimes(1);
  for (let i = 2; i < 512; i++) send(i);
  send(512); send(513);
  expect(mocks.destroy).toHaveBeenCalledTimes(512);
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ code: "media_key_budget_exhausted" }));
});
it("drops empty startup frames without bypassing encryption or poisoning the transform", async () => {
  const listeners = new Map<string, (event: object) => void>();
  const post = vi.fn(), enqueue = vi.fn();
  let transform!: (frame: { data: ArrayBuffer }, controller: { enqueue: typeof enqueue }) => Promise<void>;
  vi.stubGlobal("postMessage", post);
  vi.stubGlobal("addEventListener", (name: string, listener: (event: object) => void) => listeners.set(name, listener));
  vi.stubGlobal("TransformStream", class { constructor(value: { transform: typeof transform }) { transform = value.transform; } });
  await import("./sframe.worker");
  listeners.get("message")!({ data: { version: 1, type: "set-key", direction: "decrypt",
    contextId: "in:audio:peer", keyId: "0000000000000001", baseKey: new ArrayBuffer(16) } });
  listeners.get("rtctransform")!({ transformer: { options: { version: 1, direction: "decrypt", contextId: "in:audio:peer", frameEnvelope: "codec-prefix-v1" },
    readable: { pipeThrough: () => ({ pipeTo: () => Promise.resolve() }) }, writable: {} } });
  await transform({ data: new ArrayBuffer(0) }, { enqueue });
  expect(post).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  // A nonempty truncated packet remains a structural error, never a bypass.
  await transform({ data: new ArrayBuffer(1) }, { enqueue });
  expect(enqueue).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "transform-error", code: "media_frame_too_short" }));
});
