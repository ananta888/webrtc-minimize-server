import { Injectable, OnDestroy, signal } from "@angular/core";

export type MachineAdmissionStatus = "idle" | "checking" | "enabled" | "disabled" | "unavailable" | "stale";

// This legacy contract describes admission and the original MP4 adapter only.
// It is not the client probe, a Hub heartbeat, or a grant to receive a source.
export function parseMachineAdmission(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("machine_admission_invalid");
  const v = value as Record<string, unknown>;
  const fields = ["schema", "admissionEnabled", "publication", "sessionLease", "chatEvents", "audioSubscription", "screenPublication"];
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(key => !fields.includes(key))
    || v["schema"] !== "ananta.meet-capabilities.v1" || typeof v["admissionEnabled"] !== "boolean"
    || v["publication"] !== "mp4-v1" || v["sessionLease"] !== "ananta.meet-session-lease.v1"
    || v["chatEvents"] !== false || v["audioSubscription"] !== false || v["screenPublication"] !== false) {
    throw new Error("machine_admission_invalid");
  }
  return v["admissionEnabled"];
}

async function readAdmission(response: Response, signal: AbortSignal): Promise<boolean> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^\d{1,8}$/.test(length) || Number(length) > 2048)) {
    void response.body?.cancel().catch(() => {});
    throw new Error("machine_admission_unavailable");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 2048) throw new Error("machine_admission_oversize");
      text += decoder.decode(result.value, { stream: true });
    }
    return parseMachineAdmission(JSON.parse(text + decoder.decode()));
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cancellation must not extend the request budget, even on a faulty stream.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

@Injectable()
export class MachineAdmissionStatusService implements OnDestroy {
  readonly state = signal<MachineAdmissionStatus>("idle");
  readonly checkedAt = signal<number | null>(null);
  private pending: AbortController | null = null;
  private freshness: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  async refresh(): Promise<void> {
    if (this.destroyed || this.pending) return;
    if (this.freshness) clearTimeout(this.freshness);
    this.freshness = null;
    const controller = new AbortController();
    this.pending = controller;
    this.state.set("checking"); this.checkedAt.set(null);
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("machine_admission_cancelled"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const enabled = await Promise.race([
        fetch("/api/machine/capabilities", { method: "GET", credentials: "omit", cache: "no-store",
          redirect: "error", signal: controller.signal }).then(async response => {
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("machine_admission_cancelled"); }
          return readAdmission(response, controller.signal);
        }), aborted,
      ]);
      if (this.destroyed || controller.signal.aborted) return;
      this.state.set(enabled ? "enabled" : "disabled"); this.checkedAt.set(Date.now());
      this.freshness = setTimeout(() => { this.freshness = null; this.state.set("stale"); }, 30_000);
    } catch {
      if (!this.destroyed) this.state.set("unavailable");
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", rejectAbort);
      controller.abort();
      if (this.pending === controller) this.pending = null;
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.pending?.abort();
    if (this.freshness) clearTimeout(this.freshness);
    this.freshness = null;
    this.checkedAt.set(null); this.state.set("idle");
  }
}
