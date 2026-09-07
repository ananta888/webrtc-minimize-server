/** Bounded source lifecycle; rendering and verified session authority are ports. */
export interface MachineAvatarAuthority {
  sourceId: string; sessionId: string; leaseGeneration: number; membershipEpoch: number; expiresAt: number;
}
export interface MachineAvatarSurface {
  ready(): boolean;
  frame(sequence: number): void;
  close(): void;
}
interface AvatarPorts {
  authority(): MachineAvatarAuthority;
  create(profile: "neutral-ai-v1" | "persona-image-v1", image: unknown, check: () => void): MachineAvatarSurface;
  clock?: () => number;
}
export interface MachineAvatarReceipt {
  schema: "ananta.meet-avatar-source.v1"; profile: "neutral-ai-v1" | "persona-image-v1";
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
  private lastFrame = 0;
  private expiresAt = 0;
  private frames = 0;
  private protectionLostAt = 0;
  private controllerUntil = 0;
  private profile: "neutral-ai-v1" | "persona-image-v1" = "neutral-ai-v1";
  private readonly clock: () => number;

  constructor(private readonly ports: AvatarPorts) { this.clock = ports.clock ?? Date.now; }

  async open(sourceId: string, profile: string, image?: unknown): Promise<MachineAvatarReceipt> {
    if (this.scope) throw new Error("meet_avatar_busy");
    const authority = this.ports.authority(), now = this.clock();
    if ((profile !== "neutral-ai-v1" && profile !== "persona-image-v1")
      || (profile === "neutral-ai-v1" && image !== undefined) || (profile === "persona-image-v1" && image === undefined)
      || typeof sourceId !== "string" || sourceId !== authority.sourceId
      || !authority.sessionId || !Number.isSafeInteger(authority.leaseGeneration) || authority.leaseGeneration < 1
      || !Number.isSafeInteger(authority.membershipEpoch) || authority.membershipEpoch < 1
      || !Number.isFinite(now) || !Number.isFinite(authority.expiresAt) || authority.expiresAt <= now
      || this.generation >= 1024) throw new Error("meet_avatar_source_denied");
    this.scope = { ...authority }; this.generation++; this.state = "opening"; this.profile = profile;
    this.started = this.lastClock = now; this.lastFrame = 0; this.frames = 0; this.protectionLostAt = 0;
    this.expiresAt = Math.min(authority.expiresAt, now + 30_000);
    this.controllerUntil = now + 2500;
    const generation = this.generation;
    try { this.surface = this.ports.create(profile, image, () => {
      if (this.generation !== generation) throw new Error("meet_avatar_generation_changed");
      this.check();
    }); }
    catch (error) { this.release("failed"); throw error; }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = setInterval(() => this.tick(), 100);
      this.tick();
    });
  }

  private check(): number {
    const current = this.ports.authority(), scope = this.scope, now = this.clock();
    if (!scope || !Number.isFinite(now) || now < this.lastClock || now >= this.expiresAt || now >= this.controllerUntil
      || current.sourceId !== scope.sourceId || current.sessionId !== scope.sessionId
      || current.leaseGeneration !== scope.leaseGeneration || current.membershipEpoch !== scope.membershipEpoch
      || current.expiresAt !== scope.expiresAt) throw new Error("meet_avatar_authority_expired");
    this.lastClock = now; return now;
  }

  private tick(): void {
    try {
      const now = this.check();
      if (this.state === "opening") {
        if (now - this.started >= 10_000) throw new Error("meet_avatar_setup_timeout");
        if (!this.surface!.ready()) return;
        this.state = "open";
      } else if (!this.surface!.ready()) {
        // Adding another publication can briefly renegotiate keys. Quiesce this
        // source, never emit unprotected frames or extend the activation lease.
        if (this.state !== "waiting") { this.state = "waiting"; this.protectionLostAt = now; }
        if (now - this.protectionLostAt >= 2000) throw new Error("meet_avatar_protection_lost");
        return;
      } else { this.state = "open"; this.protectionLostAt = 0; }
      if (!this.frames || now - this.lastFrame >= 200) {
        this.surface!.frame(++this.frames); this.lastFrame = now;
      }
      if (this.pending) {
        const pending = this.pending; this.pending = undefined;
        pending.resolve({ schema: "ananta.meet-avatar-source.v1", profile: this.profile, generation: this.generation,
          width: 256, height: 256, fps: 5, heartbeatMs: 2500, expiresAt: this.expiresAt });
      }
    } catch (error) { this.release("failed", error instanceof Error ? error : new Error("meet_avatar_failed")); }
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
