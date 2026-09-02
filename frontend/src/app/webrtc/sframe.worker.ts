/// <reference lib="webworker" />

import { SFrameDecryptContext, SFrameEncryptContext } from "./sframe-codec";
import {
  decryptMediaFrame,
  EncodedMediaFrame,
  encryptMediaFrame,
  SFRAME_MEDIA_ENVELOPE,
} from "./sframe-media-envelope";

interface EncodedFrame extends EncodedMediaFrame { data: ArrayBuffer }

interface ScriptTransformer {
  readonly options: Readonly<{
    version?: unknown;
    direction?: unknown;
    contextId?: unknown;
    frameEnvelope?: unknown;
  }>;
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
const decryptorKeyIds = new Map<string, Set<string>>();
const reportedTransformFailures = new Set<string>();

function reportTransformFailure(contextId: string, direction: "encrypt" | "decrypt", error: unknown): void {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "media_transform_failed";
  if (!new Set([
    "media_frame_type", "media_codec_unsupported", "media_frame_too_short", "media_envelope_version",
  ]).has(code)) return;
  const key = `${contextId}\0${direction}\0${code}`;
  if (reportedTransformFailures.has(key)) return;
  reportedTransformFailures.add(key);
  postMessage({ version: 1, type: "transform-error", contextId, direction, code });
}

function destroyContext(contextId: string): void {
  encryptors.get(contextId)?.destroy();
  decryptors.get(contextId)?.destroy();
  encryptors.delete(contextId);
  decryptors.delete(contextId);
  decryptorKeyIds.delete(contextId);
  for (const key of reportedTransformFailures) if (key.startsWith(`${contextId}\0`)) reportedTransformFailures.delete(key);
}

function clearAll(): void {
  for (const context of encryptors.values()) context.destroy();
  for (const context of decryptors.values()) context.destroy();
  encryptors.clear();
  decryptors.clear();
  decryptorKeyIds.clear();
  reportedTransformFailures.clear();
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
    let context = decryptors.get(data.contextId);
    let keyIds = decryptorKeyIds.get(data.contextId);
    if (!context || !keyIds) {
      context = new SFrameDecryptContext();
      keyIds = new Set();
      decryptors.set(data.contextId, context);
      decryptorKeyIds.set(data.contextId, keyIds);
    }
    if (!keyIds.has(data.keyId)) {
      context.setKey(kid, key);
      keyIds.add(data.keyId);
    }
  }
  key.fill(0);
});

addEventListener("rtctransform", ((event: TransformEvent) => {
  const options = event.transformer.options;
  const contextId = String(options?.["contextId"] || "");
  const direction = options?.["direction"];
  if (options?.["version"] !== 1 || options?.["frameEnvelope"] !== SFRAME_MEDIA_ENVELOPE
    || !CONTEXT_ID.test(contextId) || (direction !== "encrypt" && direction !== "decrypt")) {
    void event.transformer.readable.cancel("invalid_sframe_transform");
    return;
  }
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      try {
        const context = direction === "encrypt" ? encryptors.get(contextId) : decryptors.get(contextId);
        if (!context) return;
        const output = direction === "encrypt"
          ? await encryptMediaFrame(context as SFrameEncryptContext, frame)
          : await decryptMediaFrame(context as SFrameDecryptContext, frame);
        frame.data = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
        controller.enqueue(frame);
      } catch (error) {
        // Authentication failures, replay, missing keys and exhausted counters are fail-closed.
        reportTransformFailure(contextId, direction, error);
      }
    },
  });
  void event.transformer.readable.pipeThrough(transform).pipeTo(event.transformer.writable).catch(() => undefined);
}) as EventListener);
