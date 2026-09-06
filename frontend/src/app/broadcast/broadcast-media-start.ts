import { BroadcastBrowserPortError } from "./broadcast-ports";

/** Bounds an explicitly requested local media start, not capture or consent. */
export async function boundedBroadcastMediaStart(operation: () => Promise<void>, signal: AbortSignal,
  timeoutCode: string, failureCode: string): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(() => finish(new BroadcastBrowserPortError(timeoutCode)), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const failed = (error: unknown) => finish(error ?? new BroadcastBrowserPortError(failureCode));
    try { Promise.resolve(operation()).then(() => finish(), failed); } catch (error) { failed(error); }
  });
}
