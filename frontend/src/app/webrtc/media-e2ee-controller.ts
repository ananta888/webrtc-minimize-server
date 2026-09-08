import { SFRAME_MEDIA_ENVELOPE } from "./sframe-media-envelope";

interface ScriptTransformTarget {
  transform: unknown | null;
}

interface ScriptTransformConstructor {
  new(
    worker: Worker,
    options: Readonly<{
      version: 1;
      direction: "encrypt" | "decrypt";
      contextId: string;
      frameEnvelope: typeof SFRAME_MEDIA_ENVELOPE;
    }>,
  ): unknown;
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

function constructor(): ScriptTransformConstructor | null {
  const value = (globalThis as typeof globalThis & { RTCRtpScriptTransform?: ScriptTransformConstructor })
    .RTCRtpScriptTransform;
  return typeof value === "function" ? value : null;
}

export function supportsMediaE2ee(): boolean {
  return typeof Worker === "function" && Boolean(constructor())
    && typeof RTCRtpSender === "function" && "transform" in RTCRtpSender.prototype
    && typeof RTCRtpReceiver === "function" && "transform" in RTCRtpReceiver.prototype;
}

export class MediaE2eeController {
  readonly supported = supportsMediaE2ee();
  private readonly attached = new WeakMap<object, string>();
  private worker: Worker | null = null;
  private workerFailed = false;

  constructor(private readonly onTransformFailure: (contextId: string, code: string) => void = () => undefined,
    private readonly onWorkerFailure: () => void = () => onTransformFailure("", "media_worker_failed")) {}

  attachSender(sender: RTCRtpSender, contextId: string): boolean {
    return this.attach(sender as unknown as ScriptTransformTarget, contextId, "encrypt");
  }

  attachReceiver(receiver: RTCRtpReceiver, contextId: string): boolean {
    return this.attach(receiver as unknown as ScriptTransformTarget, contextId, "decrypt");
  }

  setSenderKey(contextId: string, keyId: string, baseKey: Uint8Array): boolean {
    return this.setKey("encrypt", contextId, keyId, baseKey);
  }

  setReceiverKey(contextId: string, keyId: string, baseKey: Uint8Array): boolean {
    return this.setKey("decrypt", contextId, keyId, baseKey);
  }

  clearContext(contextId: string): void {
    if (!CONTEXT_ID.test(contextId)) return;
    this.post({ version: 1, type: "clear-context", contextId });
  }

  clearKeys(): void {
    this.post({ version: 1, type: "clear-all" });
  }

  destroy(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try { worker.postMessage({ version: 1, type: "clear-all" }); } catch { /* Failed workers must still terminate. */ }
    worker.terminate();
  }

  private attach(target: ScriptTransformTarget, contextId: string, direction: "encrypt" | "decrypt"): boolean {
    const Transform = constructor();
    const worker = this.ensureWorker();
    if (!Transform || !worker || !CONTEXT_ID.test(contextId)) return false;
    if (this.attached.get(target as object) === contextId) return true;
    try {
      const options = { version: 1 as const, direction, contextId, frameEnvelope: SFRAME_MEDIA_ENVELOPE };
      target.transform = new Transform(worker, options);
      this.attached.set(target as object, contextId);
      return true;
    } catch {
      return false;
    }
  }

  private setKey(
    direction: "encrypt" | "decrypt",
    contextId: string,
    keyId: string,
    baseKey: Uint8Array,
  ): boolean {
    if (!this.ensureWorker() || !CONTEXT_ID.test(contextId) || !KEY_ID.test(keyId) || baseKey.length !== 16) return false;
    const copy = Uint8Array.from(baseKey);
    const buffer = copy.buffer;
    this.worker!.postMessage({
      version: 1,
      type: "set-key",
      direction,
      contextId,
      keyId,
      baseKey: buffer,
    } satisfies WorkerCommand, [buffer]);
    return true;
  }

  private post(command: WorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private ensureWorker(): Worker | null {
    if (!this.supported || this.workerFailed) return null;
    if (!this.worker) {
      this.worker = new Worker(new URL("./sframe.worker", import.meta.url), { type: "module", name: "sframe-media" });
      const worker = this.worker;
      const failed = () => {
        if (this.worker !== worker) return;
        this.workerFailed = true;
        this.destroy(); this.onWorkerFailure();
      };
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
      this.worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        const value = data as Record<string, unknown>;
        if (Object.keys(value).length !== 5 || value["version"] !== 1 || value["type"] !== "transform-error"
          || !CONTEXT_ID.test(String(value["contextId"] || ""))
          || !new Set(["encrypt", "decrypt"]).has(String(value["direction"] || ""))
          || !new Set([
            "media_frame_type", "media_codec_unsupported", "media_frame_too_short", "media_envelope_version", "media_key_budget_exhausted",
          ]).has(String(value["code"] || ""))) return;
        this.onTransformFailure(String(value["contextId"]), String(value["code"]));
      });
    }
    return this.worker;
  }
}
