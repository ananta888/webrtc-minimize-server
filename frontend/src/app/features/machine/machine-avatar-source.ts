/** Bounded source lifecycle; rendering and verified session authority are ports. */
export interface MachineAvatarAuthority {
  sourceId: string; sessionId: string; leaseGeneration: number; membershipEpoch: number; expiresAt: number;
}
export interface MachineAvatarSurface {
  ready(): boolean;
  diagnostics?(): Record<string, unknown>;
  frame(sequence: number): void;
  close(): void;
}
export type MachineAvatarProfile = "neutral-ai-v1" | "persona-image-v1" | "persona-video-v1";
interface AvatarPorts {
  authority(): MachineAvatarAuthority;
  create(profile: MachineAvatarProfile, image: unknown, check: () => void): MachineAvatarSurface;
  clock?: () => number; // Absolute epoch time for authority and published expiry.
  monotonicClock?: () => number; // Frame/heartbeat intervals, not grant lifetime.
}
export interface MachineAvatarReceipt {
  schema: "ananta.meet-avatar-source.v1"; profile: MachineAvatarProfile;
  generation: number; width: 256; height: 256; fps: 5; heartbeatMs: 2500; expiresAt: number;
}
export class MachineAvatarSource {
  private generation = 0;
  private state: "closed" | "opening" | "open" | "waiting" | "failed" = "closed";
  private scope?: MachineAvatarAuthority;
  private surface?: MachineAvatarSurface;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: { resolve(value: MachineAvatarReceipt): void; reject(error: Error): void };
  private started = 0;
  private lastClock = 0;
  private lastMonotonic = 0;
  private lastFrame = 0;
  private expiresAt = 0;
  private frames = 0;
  private protectionLostAt = 0;
  private lastReadyLog = 0;
  private controllerUntil = 0;
  private profile: MachineAvatarProfile = "neutral-ai-v1";
  private readonly clock: () => number;
  private readonly monotonicClock: () => number;

  constructor(private readonly ports: AvatarPorts) {
    this.clock = ports.clock ?? Date.now;
    this.monotonicClock = ports.monotonicClock ?? (() => performance.now());
  }

  async open(sourceId: string, profile: string, image?: unknown): Promise<MachineAvatarReceipt> {
    if (this.scope) throw new Error("meet_avatar_busy");
    const authority = this.ports.authority(), now = this.clock(), local = this.monotonicClock();
    if ((profile !== "neutral-ai-v1" && profile !== "persona-image-v1" && profile !== "persona-video-v1")
      || (profile === "neutral-ai-v1" && image !== undefined) || (profile !== "neutral-ai-v1" && image === undefined)
      || typeof sourceId !== "string" || sourceId !== authority.sourceId
      || !authority.sessionId || !Number.isSafeInteger(authority.leaseGeneration) || authority.leaseGeneration < 1
      || !Number.isSafeInteger(authority.membershipEpoch) || authority.membershipEpoch < 1
      || !Number.isFinite(now) || !Number.isFinite(local) || local < 0
      || !Number.isFinite(authority.expiresAt) || authority.expiresAt <= now
      || this.generation >= 1024) throw new Error("meet_avatar_source_denied");
    this.scope = { ...authority }; this.generation++; this.state = "opening"; this.profile = profile;
    this.lastClock = now; this.started = this.lastMonotonic = local;
    this.lastFrame = 0; this.frames = 0; this.protectionLostAt = 0;
    this.expiresAt = Math.min(authority.expiresAt, now + 30_000);
    this.controllerUntil = local + 2500;
    const generation = this.generation;
    try { this.surface = this.ports.create(profile, image, () => {
      if (this.generation !== generation) throw new Error("meet_avatar_generation_changed");
      this.check();
    }); }
    catch (error) { this.release("failed"); throw error; }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      // Poll setup tightly: a clip swap blocks the Hub's audio loop until the
      // receipt, so readiness must not wait for a coarse frame tick.
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
    });
  }

  private check(): number {
    const current = this.ports.authority(), scope = this.scope, now = this.clock(), local = this.monotonicClock();
    const cause = !scope ? "inactive" : !Number.isFinite(now) || !Number.isFinite(local) ? "clock-invalid"
      : now < this.lastClock || local < this.lastMonotonic ? "clock-backwards"
      : now >= this.expiresAt || local >= this.started + 30_000 ? "activation-expired"
      : this.state !== "opening" && local >= this.controllerUntil ? "controller-expired" : current.sourceId !== scope.sourceId ? "source-id"
      : current.sessionId !== scope.sessionId ? "session-id" : current.leaseGeneration !== scope.leaseGeneration ? "lease-generation"
      : current.membershipEpoch !== scope.membershipEpoch ? "membership-epoch"
      : current.expiresAt !== scope.expiresAt ? "lease-expiry" : null;
    // A peer joining/leaving (membership epoch) or a session renewal (lease
    // generation/expiry) changes a soft part of the authority but not the
    // source/session identity. Rebind instead of tearing the avatar down, so a
    // synthetic source stays visible across room churn and renewals.
    const soft = cause === "membership-epoch" || cause === "lease-generation" || cause === "lease-expiry";
    if (soft && scope) {
      this.scope = Object.freeze({ ...current });
    } else if (cause) {
      // Fixed internal reason only: never retain the authority or its values.
      try {
        console.warn("[avatardbg] authority-expired cause=" + cause
          + " current=" + JSON.stringify(current) + " scope=" + JSON.stringify(scope));
      } catch { /* Diagnostics must never break the avatar. */ }
      throw new Error("meet_avatar_authority_expired:" + cause, { cause });
    }
    this.lastClock = now; this.lastMonotonic = local; return local;
  }

  private tick(): void {
    try {
      // Observe readiness once per tick: two ready() calls can disagree, and a
      // source that is up must never be fenced by the second, stale look.
      const ready = this.surface!.ready();
      if (this.state === "opening" && ready) {
        // Setup finished. Settle opening -> open before any deadline can fence
        // it: an expired activation window then ends the settled source on a
        // later tick and forces a clean re-open, instead of rejecting a setup
        // that demonstrably succeeded.
        this.state = "open"; this.protectionLostAt = 0;
        clearInterval(this.timer); this.timer = setInterval(() => this.tick(), 100);
        this.render(this.progress());
        return;
      }
      const now = this.check();
      if (this.state === "opening") {
        // The synthetic avatar only becomes ready once its publication is
        // media-E2EE protected, which needs the media-key handshake to land.
        // 10s was too tight and caused black/no-stream churn; give it 30s.
        if (now - this.started >= 10_000) throw new Error("meet_avatar_setup_timeout");
        if (now - this.lastReadyLog >= 1000) {
          this.lastReadyLog = now;
          try {
            console.warn("[avatardbg] opening " + JSON.stringify(this.surface!.diagnostics?.() ?? {}));
          } catch { /* Diagnostics must never break the avatar. */ }
        }
        return;
      }
      if (!ready) {
        // Adding another publication can briefly renegotiate keys. Quiesce this
        // source, never emit unprotected frames or extend the activation lease.
        if (this.state !== "waiting") { this.state = "waiting"; this.protectionLostAt = now; }
        if (now - this.protectionLostAt >= 2000) throw new Error("meet_avatar_protection_lost");
        return;
      }
      this.state = "open"; this.protectionLostAt = 0;
      this.render(now);
    } catch (error) { this.release("failed", error instanceof Error ? error : new Error("meet_avatar_failed")); }
  }

  /** Monotonic progress without the authority fence, for an already settled setup. */
  private progress(): number {
    const local = this.monotonicClock();
    if (Number.isFinite(local) && local >= this.lastMonotonic) this.lastMonotonic = local;
    return this.lastMonotonic;
  }

  /** Paces frames and hands out the one-shot receipt; a released generation has none. */
  private render(now: number): void {
    if (!this.frames || now - this.lastFrame >= 200) {
      this.surface!.frame(++this.frames); this.lastFrame = now;
    }
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.resolve({ schema: "ananta.meet-avatar-source.v1", profile: this.profile, generation: this.generation,
      width: 256, height: 256, fps: 5, heartbeatMs: 2500, expiresAt: this.expiresAt });
  }

  status() {
    if (this.scope) { try { this.check(); } catch { this.release("failed"); } }
    return { state: this.state, generation: this.generation, frames: this.frames, expiresAt: this.expiresAt };
  }

  close(expectedGeneration?: number): boolean {
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.generation)) return false;
    this.release("closed"); return true;
  }

  pulse(expectedGeneration: number): void {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.generation) throw new Error("meet_avatar_pulse_stale");
    try { this.controllerUntil = this.check() + 2500; }
    catch (error) { this.release("failed"); throw error; }
  }

  private release(state: "closed" | "failed", error = new Error("meet_avatar_closed")): void {
    clearInterval(this.timer); this.timer = undefined;
    const surface = this.surface, pending = this.pending;
    this.surface = undefined; this.scope = undefined; this.pending = undefined; this.state = state;
    try { surface?.close(); } catch { /* State is already fenced; cleanup cannot reopen it. */ }
    pending?.reject(error);
  }
}
