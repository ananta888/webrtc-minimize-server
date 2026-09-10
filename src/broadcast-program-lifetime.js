// A process-local runtime budget, not a lease, identity or membership authority.
export const BROADCAST_PROGRAM_RUNTIME_DEFAULT_MS = 4 * 60 * 60_000;
export function normalizeBroadcastProgramRuntime(value = BROADCAST_PROGRAM_RUNTIME_DEFAULT_MS) {
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 86_400_000) {
    throw new Error("invalid_broadcast_program_runtime");
  }
  return value;
}

export class BroadcastProgramLifetime {
  #expiresAt;
  #observedAt;
  #expired = false;
  constructor(duration, now) {
    normalizeBroadcastProgramRuntime(duration);
    if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(now + duration)) {
      throw new Error("invalid_broadcast_program_clock");
    }
    this.#observedAt = now;
    this.#expiresAt = now + duration;
  }
  observe(now) {
    if (this.#expired) return false;
    if (!Number.isSafeInteger(now) || now < this.#observedAt) this.#expired = true;
    else {
      this.#observedAt = now;
      if (now >= this.#expiresAt) this.#expired = true;
    }
    return !this.#expired;
  }
  get expiresAt() { return this.#expiresAt; }
  get observedAt() { return this.#observedAt; }
}
