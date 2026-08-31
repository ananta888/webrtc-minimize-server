/// <reference lib="webworker" />

import { SFrameDecryptContext, SFrameEncryptContext } from "./sframe-codec";

interface EncodedFrame {
  data: ArrayBuffer;
}

interface ScriptTransformer {
  readonly options: unknown;
  readonly readable: ReadableStream<EncodedFrame>;
  readonly writable: WritableStream<EncodedFrame>;
}

interface TransformEvent extends Event {
  readonly transformer: ScriptTransformer;
}

interface WorkerCommand {
  readonly version: 1;
  readonly type: "set-key" | "clear-context" | "clear-all";
  readonly direction?: "encrypt" | "decrypt";
  readonly contextId?: string;
  readonly keyId?: string;
  readonly baseKey?: ArrayBuffer;
}

const CONTEXT_ID = /^[A-Za-z0-9:_={}\-]{1,196}$/;
const KEY_ID = /^[a-f0-9]{16}$/;
const encryptors = new Map<string, SFrameEncryptContext>();
const decryptors = new Map<string, SFrameDecryptContext>();
const decryptorKeyIds = new Map<string, string>();

function destroyContext(contextId: string): void {
  encryptors.get(contextId)?.destroy();
  decryptors.get(contextId)?.destroy();
  encryptors.delete(contextId);
  decryptors.delete(contextId);
  decryptorKeyIds.delete(contextId);
}

function clearAll(): void {
  for (const context of encryptors.values()) context.destroy();
  for (const context of decryptors.values()) context.destroy();
  encryptors.clear();
  decryptors.clear();
  decryptorKeyIds.clear();
}

addEventListener("message", ({ data }: MessageEvent<WorkerCommand>) => {
  if (!data || data.version !== 1) return;
  if (data.type === "clear-all") {
    clearAll();
    return;
  }
  if (!data.contextId || !CONTEXT_ID.test(data.contextId)) return;
  if (data.type === "clear-context") {
    destroyContext(data.contextId);
    return;
  }
  if (data.type !== "set-key" || !data.direction || !data.keyId || !KEY_ID.test(data.keyId)
    || !(data.baseKey instanceof ArrayBuffer) || data.baseKey.byteLength !== 16) return;
  const kid = BigInt(`0x${data.keyId}`);
  const key = new Uint8Array(data.baseKey);
  if (data.direction === "encrypt") {
    encryptors.get(data.contextId)?.destroy();
    encryptors.set(data.contextId, new SFrameEncryptContext(kid, key));
  } else {
    if (decryptorKeyIds.get(data.contextId) !== data.keyId) {
      decryptors.get(data.contextId)?.destroy();
      const context = new SFrameDecryptContext();
      context.setKey(kid, key);
      decryptors.set(data.contextId, context);
      decryptorKeyIds.set(data.contextId, data.keyId);
    }
  }
  key.fill(0);
});

addEventListener("rtctransform", ((event: TransformEvent) => {
  const options = event.transformer.options as Record<string, unknown> | null;
  const contextId = String(options?.["contextId"] || "");
  const direction = options?.["direction"];
  if (!CONTEXT_ID.test(contextId) || (direction !== "encrypt" && direction !== "decrypt")) {
    void event.transformer.readable.cancel("invalid_sframe_transform");
    return;
  }
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      try {
        const input = new Uint8Array(frame.data);
        const output = direction === "encrypt"
          ? await encryptors.get(contextId)?.encrypt(input)
          : await decryptors.get(contextId)?.decrypt(input);
        if (!output) return;
        frame.data = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
        controller.enqueue(frame);
      } catch {
        // Authentication failures, replay, missing keys and exhausted counters are fail-closed.
      }
    },
  });
  void event.transformer.readable.pipeThrough(transform).pipeTo(event.transformer.writable).catch(() => undefined);
}) as EventListener);
