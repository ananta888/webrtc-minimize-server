import { BroadcastBrowserPortError } from "./broadcast-ports";

interface CompositionResource { close(): Promise<void>; }

function closeResource(resource: CompositionResource): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new BroadcastBrowserPortError("broadcast_composition_cleanup_timeout")), 5_000);
    Promise.resolve().then(() => resource.close()).then(() => { clearTimeout(timeout); resolve(); },
      error => { clearTimeout(timeout); reject(error); });
  });
}

/** Owns setup and acquired resources; late adapter results never regain authority. */
export class BroadcastCompositionLifetime {
  private readonly controller = new AbortController();
  private readonly resources = new Set<CompositionResource>();
  private closing: Promise<void> | null = null;
  private revoked = false;
  private readonly externalAbort = () => { void this.close(this.external.reason).catch(() => {}); };
  readonly signal = this.controller.signal;

  constructor(private readonly external: AbortSignal, private readonly onClosed: () => void,
    private readonly onDisposed: () => void = () => {}) {
    external.throwIfAborted();
    external.addEventListener("abort", this.externalAbort, { once: true });
  }

  async acquire<T extends CompositionResource>(create: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); this.signal.removeEventListener("abort", aborted); operation();
      };
      const aborted = () => finish(() => reject(this.signal.reason));
      const timeout = setTimeout(() => {
        void this.close(new BroadcastBrowserPortError("broadcast_composition_setup_timeout")).catch(() => {});
      }, 10_000);
      this.signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => { this.signal.throwIfAborted(); return create(this.signal); }).then(resource => {
        if (!resource || typeof resource.close !== "function") throw new BroadcastBrowserPortError("invalid_broadcast_composition_resource");
        if (settled || this.signal.aborted) { void closeResource(resource).catch(() => {}); return; }
        this.resources.add(resource); finish(() => resolve(resource));
      }).catch(error => finish(() => reject(error)));
    });
  }

  close(reason: unknown = new BroadcastBrowserPortError("broadcast_composition_closed")): Promise<void> {
    if (this.closing) return this.closing;
    // Install the promise before abort dispatch, so reentrant cleanup shares it.
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.external.removeEventListener("abort", this.externalAbort);
    if (!this.revoked) { this.revoked = true; this.controller.abort(reason); this.onClosed(); }
    const resources = [...this.resources];
    void Promise.allSettled(resources.map(closeResource)).then(results => {
      results.forEach((result, index) => { if (result.status === "fulfilled") this.resources.delete(resources[index]); });
      if (results.some(result => result.status === "rejected")) {
        this.closing = null; reject(new BroadcastBrowserPortError("broadcast_composition_cleanup_failed"));
      } else { this.onDisposed(); resolve(); }
    });
    return this.closing;
  }
}
