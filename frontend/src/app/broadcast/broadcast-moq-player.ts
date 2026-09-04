export type MoqPlaybackMode = "auto" | "hls-only" | "diagnose-moq";
export type MoqPlaybackLifecycle =
  "idle" | "probing" | "connecting-moq" | "playing-moq" | "falling-back"
  | "playing-hls" | "failed" | "closed";

export interface MoqPlaybackPlan {
  readonly trigger: "user-action";
  readonly mode: MoqPlaybackMode;
  readonly tenantId: string;
  readonly programId: string;
  readonly programEpoch: number;
  readonly audienceId: string;
  readonly namespace: string;
  readonly endpointRef: string;
  readonly manifestUrl: string;
  readonly codec: "opus" | "aac" | "vp8" | "vp9" | "h264" | "av1";
  readonly authorized: boolean;
  readonly negotiation: {
    readonly transport: "moq" | "ll-hls" | "hls";
    readonly experimental: boolean;
    readonly reasonCode: string;
    readonly tenantId: string;
    readonly programId: string;
    readonly programEpoch: number;
    readonly audienceId: string;
    readonly moqtVersion?: string;
    readonly locVersion?: string;
    readonly webTransportVersion?: string;
    readonly codec?: string;
  };
}

export type MoqPlaybackEvent =
  | { readonly kind: "first-frame"; readonly captureTimestampMs: number | null }
  | { readonly kind: "object-received"; readonly bytes: number }
  | { readonly kind: "object-lost"; readonly count: number }
  | { readonly kind: "group-dropped"; readonly count: number }
  | { readonly kind: "decode-backpressure"; readonly count: number }
  | { readonly kind: "rebuffer-start" }
  | { readonly kind: "rebuffer-end" }
  | { readonly kind: "fatal"; readonly reason: "handshake" | "auth" | "codec" | "relay" | "network" | "stall" };

export interface MoqPlaybackSession {
  readonly quicConnected: true;
  close(): Promise<void>;
}

export interface MoqPlaybackPort {
  open(request: {
    readonly endpointRef: string;
    readonly namespace: string;
    readonly codec: string;
    readonly signal: AbortSignal;
    readonly onEvent: (event: MoqPlaybackEvent) => void;
  }): Promise<MoqPlaybackSession>;
}

export interface HlsFallbackPlaybackPort {
  open(manifestUrl: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface MoqBrowserProbe {
  readonly secureContext: boolean;
  readonly webTransportAvailable: boolean;
  decodeSupported(codec: MoqPlaybackPlan["codec"]): Promise<boolean>;
}

export interface MoqPlaybackMetrics {
  readonly path: "none" | "moq" | "hls";
  readonly moqJoinMs: number | null;
  readonly endToGlassMs: number | null;
  readonly rebufferMs: number;
  readonly objectLoss: number;
  readonly droppedGroups: number;
  readonly decodeBackpressure: number;
  readonly egressBytes: number;
  readonly fallbackCount: number;
}

export interface MoqPlaybackSnapshot {
  readonly lifecycle: MoqPlaybackLifecycle;
  readonly requestedMode: MoqPlaybackMode;
  readonly activePath: "none" | "moq" | "hls";
  readonly experimental: boolean;
  readonly reasonCode: string | null;
  readonly metrics: MoqPlaybackMetrics;
}

const PLAN_FIELDS = new Set([
  "trigger", "mode", "tenantId", "programId", "programEpoch", "audienceId", "namespace",
  "endpointRef", "manifestUrl", "codec", "authorized", "negotiation",
]);
const NEGOTIATION_FIELDS = new Set([
  "transport", "experimental", "reasonCode", "tenantId", "programId", "programEpoch",
  "audienceId", "moqtVersion", "locVersion", "webTransportVersion", "secureObjectsVersion",
  "codec", "maxCatalogBytes", "maxObjectBytes",
]);
const ID = {
  tenantId: /^tn_[A-Za-z0-9_-]{16,64}$/,
  programId: /^prg_[A-Za-z0-9_-]{16,64}$/,
  audienceId: /^aud_[A-Za-z0-9_-]{16,64}$/,
};
const ENDPOINT_REF = /^moqe_[A-Za-z0-9_-]{16,64}$/;
const REASON = /^[a-z][a-z0-9_-]{2,63}$/;
const EVENT_FIELDS: Record<MoqPlaybackEvent["kind"], ReadonlySet<string>> = {
  "first-frame": new Set(["kind", "captureTimestampMs"]),
  "object-received": new Set(["kind", "bytes"]),
  "object-lost": new Set(["kind", "count"]),
  "group-dropped": new Set(["kind", "count"]),
  "decode-backpressure": new Set(["kind", "count"]),
  "rebuffer-start": new Set(["kind"]),
  "rebuffer-end": new Set(["kind"]),
  fatal: new Set(["kind", "reason"]),
};
const MOQ_PINS = Object.freeze({
  transport: "draft-ietf-moq-transport-20",
  loc: "draft-ietf-moq-loc-04",
  webTransport: "RFC 9297",
});
const MAX_FALLBACK_WINDOW_MS = 10_000;
const MOQ_CONNECT_TIMEOUT_MS = 5_000;
const MAX_PLAYBACK_PLAN_BYTES = 16 * 1024;

export class BroadcastMoqPlayerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BroadcastMoqPlayerError";
  }
}

const fail = (code: string): never => { throw new BroadcastMoqPlayerError(code); };

function exactObject(value: unknown, fields: ReadonlySet<string>, code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function clonePlan(value: MoqPlaybackPlan): MoqPlaybackPlan {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail("invalid_moq_playback_plan");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_PLAYBACK_PLAN_BYTES) {
    return fail("moq_playback_plan_too_large");
  }
  try {
    return JSON.parse(serialized) as MoqPlaybackPlan;
  } catch {
    return fail("invalid_moq_playback_plan");
  }
}

function validatePlan(value: MoqPlaybackPlan): MoqPlaybackPlan {
  exactObject(value, PLAN_FIELDS, "invalid_moq_playback_plan");
  exactObject(value.negotiation, NEGOTIATION_FIELDS, "invalid_moq_playback_negotiation");
  if (value.trigger !== "user-action" || !["auto", "hls-only", "diagnose-moq"].includes(value.mode)
    || !ID.tenantId.test(value.tenantId) || !ID.programId.test(value.programId)
    || !ID.audienceId.test(value.audienceId) || !Number.isSafeInteger(value.programEpoch)
    || value.programEpoch < 1 || !ENDPOINT_REF.test(value.endpointRef)
    || typeof value.manifestUrl !== "string" || value.manifestUrl.length > 2048
    || !["opus", "aac", "vp8", "vp9", "h264", "av1"].includes(value.codec)
    || typeof value.authorized !== "boolean" || !REASON.test(value.negotiation.reasonCode)
    || !["moq", "ll-hls", "hls"].includes(value.negotiation.transport)
    || typeof value.negotiation.experimental !== "boolean") fail("invalid_moq_playback_plan");
  const expectedNamespace = `${value.tenantId}/${value.programId}/epoch/${value.programEpoch}`;
  if (value.namespace !== expectedNamespace) fail("moq_playback_namespace_mismatch");
  for (const field of ["tenantId", "programId", "programEpoch", "audienceId"] as const) {
    if (value[field] !== value.negotiation[field]) fail(`moq_playback_${field}_mismatch`);
  }
  if (value.negotiation.transport === "moq" && (
    value.negotiation.experimental !== true
    || value.negotiation.moqtVersion !== MOQ_PINS.transport
    || value.negotiation.locVersion !== MOQ_PINS.loc
    || value.negotiation.webTransportVersion !== MOQ_PINS.webTransport
    || value.negotiation.codec !== value.codec
  )) fail("moq_playback_version_mismatch");
  return value;
}

function initialMetrics(): MoqPlaybackMetrics {
  return Object.freeze({
    path: "none", moqJoinMs: null, endToGlassMs: null, rebufferMs: 0,
    objectLoss: 0, droppedGroups: 0, decodeBackpressure: 0, egressBytes: 0,
    fallbackCount: 0,
  });
}

export class BroadcastMoqPlayer {
  private lifecycle: MoqPlaybackLifecycle = "idle";
  private requestedMode: MoqPlaybackMode = "auto";
  private activePath: "none" | "moq" | "hls" = "none";
  private reasonCode: string | null = null;
  private metrics: MoqPlaybackMetrics = initialMetrics();
  private rootController: AbortController | null = null;
  private moqController: AbortController | null = null;
  private moqSession: MoqPlaybackSession | null = null;
  private plan: MoqPlaybackPlan | null = null;
  private startedAt = 0;
  private rebufferStartedAt: number | null = null;
  private fallbackPromise: Promise<void> | null = null;
  private externalSignal: AbortSignal | null = null;
  private externalAbortListener: (() => void) | null = null;

  constructor(
    private readonly moq: MoqPlaybackPort,
    private readonly hls: HlsFallbackPlaybackPort,
    private readonly probe: MoqBrowserProbe,
    private readonly onState: (snapshot: MoqPlaybackSnapshot) => void = () => undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  snapshot(): MoqPlaybackSnapshot {
    return Object.freeze({
      lifecycle: this.lifecycle,
      requestedMode: this.requestedMode,
      activePath: this.activePath,
      experimental: this.activePath === "moq",
      reasonCode: this.reasonCode,
      metrics: this.metrics,
    });
  }

  async start(rawPlan: MoqPlaybackPlan, signal: AbortSignal): Promise<void> {
    if (this.lifecycle !== "idle") fail("moq_player_already_started");
    const plan = validatePlan(clonePlan(rawPlan));
    this.plan = plan;
    this.requestedMode = plan.mode;
    this.startedAt = this.clock();
    this.rootController = new AbortController();
    this.externalSignal = signal;
    this.externalAbortListener = () => void this.stop("aborted");
    signal.addEventListener("abort", this.externalAbortListener, { once: true });
    if (signal.aborted) return this.stop("aborted");
    this.setState("probing", "none", null);

    if (!plan.authorized) {
      this.setState("failed", "none", "playback_authorization_unavailable");
      return;
    }
    if (plan.mode === "hls-only") return this.openHls("manual_hls_selection");
    if (plan.negotiation.transport !== "moq") return this.openHls(plan.negotiation.reasonCode);
    if (!this.probe.secureContext) return this.openHls("moq_secure_context_unavailable");
    if (!this.probe.webTransportAvailable) return this.openHls("moq_webtransport_unavailable");
    if (!await this.probe.decodeSupported(plan.codec)) return this.openHls("moq_codec_unavailable");
    if (this.rootController.signal.aborted) return;
    await this.openMoq();
  }

  async stop(reasonCode = "user_stop"): Promise<void> {
    if (this.lifecycle === "closed") return;
    if (this.externalSignal && this.externalAbortListener) {
      this.externalSignal.removeEventListener("abort", this.externalAbortListener);
    }
    this.externalSignal = null;
    this.externalAbortListener = null;
    this.rootController?.abort(new DOMException("stop", "AbortError"));
    this.moqController?.abort(new DOMException("stop", "AbortError"));
    this.finishRebuffer();
    const session = this.moqSession;
    this.moqSession = null;
    if (session) await session.close().catch(() => undefined);
    await this.hls.close().catch(() => undefined);
    this.setState("closed", "none", reasonCode);
    this.plan = null;
  }

  private async openMoq(): Promise<void> {
    const plan = this.plan!;
    this.moqController = new AbortController();
    const rootAbort = () => this.moqController?.abort(new DOMException("stop", "AbortError"));
    this.rootController!.signal.addEventListener("abort", rootAbort, { once: true });
    this.setState("connecting-moq", "none", null);
    const openPromise = this.moq.open({
      endpointRef: plan.endpointRef,
      namespace: plan.namespace,
      codec: plan.codec,
      signal: this.moqController.signal,
      onEvent: (event) => this.handleEvent(event),
    });
    void openPromise.then((session) => {
      if (this.moqController?.signal.aborted && session?.close) void session.close();
    }, () => undefined);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const session = await Promise.race([
        openPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new BroadcastMoqPlayerError("moq_handshake_timeout")),
            MOQ_CONNECT_TIMEOUT_MS);
        }),
      ]);
      if (!session || session.quicConnected !== true || typeof session.close !== "function") {
        fail("invalid_moq_playback_session");
      }
      if (this.moqController.signal.aborted || this.rootController?.signal.aborted) {
        await session.close().catch(() => undefined);
        return;
      }
      this.moqSession = session;
      this.setState("playing-moq", "moq", "moq_compatible");
    } catch (error) {
      if (this.rootController?.signal.aborted) return;
      await this.fallback(error instanceof BroadcastMoqPlayerError ? error.code : "moq_handshake_failed");
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      this.rootController?.signal.removeEventListener("abort", rootAbort);
    }
  }

  private handleEvent(event: MoqPlaybackEvent): void {
    if (!event || typeof event !== "object" || !("kind" in event)
      || !Object.prototype.hasOwnProperty.call(EVENT_FIELDS, event.kind)
      || Object.keys(event).some((field) => !EVENT_FIELDS[event.kind]?.has(field))) {
      void this.fallback("invalid_moq_event");
      return;
    }
    const now = this.clock();
    switch (event.kind) {
      case "first-frame":
        if (event.captureTimestampMs !== null && (!Number.isFinite(event.captureTimestampMs)
          || event.captureTimestampMs < 0 || event.captureTimestampMs > now)) return void this.fallback("invalid_moq_event");
        this.updateMetrics({
          moqJoinMs: this.metrics.moqJoinMs ?? Math.max(0, now - this.startedAt),
          endToGlassMs: event.captureTimestampMs === null ? null : Math.max(0, now - event.captureTimestampMs),
        });
        break;
      case "object-received":
        if (!Number.isSafeInteger(event.bytes) || event.bytes < 0 || event.bytes > 1_048_576) return void this.fallback("invalid_moq_event");
        this.updateMetrics({ egressBytes: this.metrics.egressBytes + event.bytes });
        break;
      case "object-lost": this.addBounded("objectLoss", event.count); break;
      case "group-dropped": this.addBounded("droppedGroups", event.count); break;
      case "decode-backpressure": this.addBounded("decodeBackpressure", event.count); break;
      case "rebuffer-start":
        if (this.rebufferStartedAt === null) this.rebufferStartedAt = now;
        break;
      case "rebuffer-end": this.finishRebuffer(); break;
      case "fatal":
        if (!["handshake", "auth", "codec", "relay", "network", "stall"].includes(event.reason)) {
          void this.fallback("invalid_moq_event");
        } else void this.fallback(`moq_${event.reason}_failed`);
        break;
      default: void this.fallback("invalid_moq_event");
    }
  }

  private addBounded(field: "objectLoss" | "droppedGroups" | "decodeBackpressure", count: number): void {
    if (!Number.isSafeInteger(count) || count < 1 || count > 65_535) return void this.fallback("invalid_moq_event");
    this.updateMetrics({ [field]: Math.min(Number.MAX_SAFE_INTEGER, this.metrics[field] + count) });
  }

  private finishRebuffer(): void {
    if (this.rebufferStartedAt === null) return;
    const elapsed = Math.max(0, this.clock() - this.rebufferStartedAt);
    this.rebufferStartedAt = null;
    this.updateMetrics({ rebufferMs: this.metrics.rebufferMs + elapsed });
  }

  private async fallback(reasonCode: string): Promise<void> {
    if (this.fallbackPromise) return this.fallbackPromise;
    this.fallbackPromise = this.performFallback(reasonCode);
    return this.fallbackPromise;
  }

  private async performFallback(reasonCode: string): Promise<void> {
    if (!this.plan || this.rootController?.signal.aborted) return;
    if (this.metrics.fallbackCount >= 1 || this.clock() - this.startedAt > MAX_FALLBACK_WINDOW_MS) {
      this.setState("failed", "none", "moq_fallback_budget_exhausted");
      return;
    }
    this.updateMetrics({ fallbackCount: this.metrics.fallbackCount + 1 });
    this.setState("falling-back", "none", reasonCode);
    this.moqController?.abort(new DOMException("fallback", "AbortError"));
    const session = this.moqSession;
    this.moqSession = null;
    if (session) await session.close().catch(() => undefined);
    await this.openHls(reasonCode);
  }

  private async openHls(reasonCode: string): Promise<void> {
    if (!this.plan || this.rootController?.signal.aborted) return;
    try {
      await this.hls.open(this.plan.manifestUrl, this.rootController!.signal);
      this.setState("playing-hls", "hls", reasonCode);
    } catch {
      if (!this.rootController?.signal.aborted) this.setState("failed", "none", "hls_fallback_failed");
    }
  }

  private updateMetrics(patch: Partial<MoqPlaybackMetrics>): void {
    this.metrics = Object.freeze({ ...this.metrics, ...patch, path: this.activePath });
    this.emit();
  }

  private setState(lifecycle: MoqPlaybackLifecycle, activePath: "none" | "moq" | "hls", reasonCode: string | null): void {
    this.lifecycle = lifecycle;
    this.activePath = activePath;
    this.reasonCode = reasonCode;
    this.metrics = Object.freeze({ ...this.metrics, path: activePath });
    this.emit();
  }

  private emit(): void {
    this.onState(this.snapshot());
  }
}
