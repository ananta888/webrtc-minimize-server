/** One timer owner; a stale callback can never end a freshly renewed session. */
export class MachineLeaseExpiry {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(private readonly current: () => number, private readonly expire: () => void) {}
  arm(deadline: number): void {
    this.close();
    if (!Number.isSafeInteger(deadline) || deadline <= 0) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      const current = this.current();
      if (current !== deadline || Date.now() < deadline) { this.arm(current); return; }
      this.close(); this.expire();
    }, Math.max(1, deadline - Date.now()));
  }
  close(): void { ++this.generation; clearTimeout(this.timer); this.timer = undefined; }
}
