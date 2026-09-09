/** Bounds waiting, not the lifetime of an underlying crypto/browser Promise.
 * Session owners must still fence late results and retire their own resources. */
export class SessionOperation {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number, private readonly timeoutCode: string,
    private readonly cancelCode = "session_operation_cancelled") {
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.controller.abort(new Error(timeoutCode)), timeoutMs);
  }

  private check(): void {
    if (performance.now() >= this.deadline) this.controller.abort(new Error(this.timeoutCode));
    this.signal.throwIfAborted();
  }

  async wait<T>(start: () => Promise<T>): Promise<T> {
    this.check();
    let stop: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", stop, { once: true });
    });
    // Attach both handlers even when start throws or aborts synchronously.
    const work = new Promise<T>(resolve => { this.check(); resolve(start()); });
    try {
      const value = await Promise.race([work, cancelled]);
      this.check();
      return value;
    } finally { this.signal.removeEventListener("abort", stop); }
  }

  async pause(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await this.wait(() => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  abort(): void { this.controller.abort(new Error(this.cancelCode)); this.dispose(); }
  dispose(): void { clearTimeout(this.timer); }
}
