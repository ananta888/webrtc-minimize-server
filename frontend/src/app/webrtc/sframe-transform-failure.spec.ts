import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ encrypt: vi.fn(), decrypt: vi.fn(), destroy: vi.fn(), set: vi.fn() }));
vi.mock("./sframe-codec", () => ({
  SFrameEncryptContext: class { destroy = mocks.destroy; },
  SFrameDecryptContext: class { destroy = mocks.destroy; setKey = mocks.set; removeKey = vi.fn(); },
}));
vi.mock("./sframe-media-envelope", () => ({
  encryptMediaFrame: mocks.encrypt, decryptMediaFrame: mocks.decrypt, SFRAME_MEDIA_ENVELOPE: "codec-prefix-v1",
}));

type Frame = { data: ArrayBuffer };
type Transform = (frame: Frame, controller: { enqueue: (frame: Frame) => void }) => Promise<void>;

async function fixture(direction: "encrypt" | "decrypt") {
  const listeners = new Map<string, (event: object) => void>();
  let current!: Transform;
  const post = vi.fn();
  vi.stubGlobal("postMessage", post);
  vi.stubGlobal("addEventListener", (name: string, fn: (event: object) => void) => listeners.set(name, fn));
  vi.stubGlobal("TransformStream", class { constructor(value: { transform: Transform }) { current = value.transform; } });
  await import("./sframe.worker");
  const command = (data: object) => listeners.get("message")!({ data: { version: 1, ...data } });
  const key = (contextId = "source", keyId = "0000000000000001") => {
    const baseKey = new Uint8Array(16).fill(7);
    command({ type: "set-key", direction, contextId, keyId, baseKey: baseKey.buffer });
    expect([...baseKey]).toEqual(Array(16).fill(0));
  };
  const stream = (contextId = "source") => {
    listeners.get("rtctransform")!({ transformer: {
      options: { version: 1, direction, contextId, frameEnvelope: "codec-prefix-v1" },
      readable: { pipeThrough: () => ({ pipeTo: () => Promise.resolve() }) }, writable: {},
    } });
    const transform = current, enqueue = vi.fn();
    return { enqueue, frame: () => transform({ data: new ArrayBuffer(32) }, { enqueue }) };
  };
  return { command, key, stream, post, operation: direction === "encrypt" ? mocks.encrypt : mocks.decrypt };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); vi.resetModules(); });

describe.each(["encrypt", "decrypt"] as const)("%s structural failure fencing", direction => {
  it.each(["media_frame_type", "media_codec_unsupported", "media_frame_too_short", "media_envelope_version"])(
    "retires a transform permanently after %s without stopping another source",
    async code => {
      const f = await fixture(direction); f.key();
      const source = f.stream();
      f.operation.mockRejectedValueOnce({ code }).mockResolvedValue(Uint8Array.of(42));
      await source.frame();
      expect(f.post).toHaveBeenCalledExactlyOnceWith({ version: 1, type: "transform-error", contextId: "source", direction, code });
      expect(mocks.destroy).toHaveBeenCalledOnce();
      const sets = mocks.set.mock.calls.length;
      f.key("source", "0000000000000002");
      expect(mocks.set).toHaveBeenCalledTimes(sets);
      await source.frame();
      expect(f.operation).toHaveBeenCalledOnce();
      expect(source.enqueue).not.toHaveBeenCalled();
      f.key("other"); const other = f.stream("other"); await other.frame();
      expect(other.enqueue).toHaveBeenCalledOnce();
      // Explicit teardown permits a new source lifecycle, never the failed stream.
      f.command({ type: "clear-context", contextId: "source" }); f.key();
      await source.frame(); expect(source.enqueue).not.toHaveBeenCalled();
      const fresh = f.stream(); await fresh.frame(); expect(fresh.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["unknown_kid", "authentication_failed", "replay_rejected"])(
    "drops only the rejected packet for %s, preserving authenticated recovery",
    async code => {
      const f = await fixture(direction); f.key(); const source = f.stream();
      f.operation.mockRejectedValueOnce({ code }).mockResolvedValue(Uint8Array.of(42));
      await source.frame(); expect(source.enqueue).not.toHaveBeenCalled();
      await source.frame(); expect(source.enqueue).toHaveBeenCalledOnce();
      expect(f.post).not.toHaveBeenCalled(); expect(mocks.destroy).not.toHaveBeenCalled();
    },
  );
});
