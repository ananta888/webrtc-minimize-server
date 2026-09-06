import { Injectable, signal } from "@angular/core";
import { BroadcastDirectoryEntry, BroadcastDirectoryService, BroadcastPlaybackBootstrap } from "./broadcast-directory.service";
import { BroadcastPlaybackGatewayService } from "./broadcast-playback-gateway.service";
import { BroadcastBrowserPortError } from "./broadcast-ports";

interface Watch {
  readonly controller: AbortController;
  readonly programId: string;
  resourceRef: string;
  started: boolean;
  replacements: number[];
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const abort = () => finish(signal.reason);
    function finish(error?: unknown): void {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

@Injectable()
export class BroadcastViewerWorkflowService {
  readonly selected = signal<BroadcastDirectoryEntry | null>(null);
  readonly manifestUrl = signal("");
  readonly playbackSessionId = signal("");
  readonly opening = signal(false);
  readonly reconnecting = signal(false);
  readonly errorCode = signal("");
  private watch: Watch | null = null;
  private work: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly directory: BroadcastDirectoryService, private readonly gateway: BroadcastPlaybackGatewayService) {}

  async open(entry: BroadcastDirectoryEntry, trigger: unknown): Promise<void> {
    if (trigger !== "user-action") throw new BroadcastBrowserPortError("explicit_broadcast_viewer_start_required");
    if (this.destroyed || this.opening() || !["live", "degraded"].includes(entry.availability)) return;
    this.clear();
    const watch: Watch = { controller: new AbortController(), programId: entry.programId,
      resourceRef: "", started: false, replacements: [] };
    this.watch = watch;
    this.opening.set(true);
    this.errorCode.set("");
    const lifetime = AbortSignal.any([watch.controller.signal, AbortSignal.timeout(30_000)]);
    try {
      await this.gateway.close();
      this.current(watch, lifetime);
      const bootstrap = await this.directory.authorize(entry.programId, lifetime);
      this.current(watch, lifetime);
      if (bootstrap.program.programId !== watch.programId) throw new Error("broadcast_playback_scope_changed");
      const session = await this.gateway.open(bootstrap.resourceRef, bootstrap.playbackGrant, lifetime);
      this.current(watch, lifetime);
      watch.resourceRef = bootstrap.resourceRef;
      this.selected.set(bootstrap.program);
      this.manifestUrl.set(session.manifestUrl);
      this.playbackSessionId.set(session.playbackSessionId);
      this.schedule(watch, session.expiresAt);
    } catch (error) {
      if (this.watch === watch) await this.fail(watch, error);
    } finally { if (this.watch === watch) this.opening.set(false); }
  }

  playbackStarted(manifestUrl: string): void {
    if (this.watch && this.selected() && manifestUrl === this.manifestUrl()) this.watch.started = true;
  }

  async interrupted(manifestUrl: string): Promise<void> {
    const watch = this.watch;
    if (!watch?.started || manifestUrl !== this.manifestUrl() || this.reconnecting() || this.destroyed) return;
    await this.recover(watch);
  }

  async close(): Promise<void> {
    this.clear();
    try { await this.gateway.close(); }
    catch { if (!this.watch && !this.destroyed) this.errorCode.set("broadcast_playback_close_failed"); }
  }

  async destroy(): Promise<void> { this.destroyed = true; await this.close(); }

  private clear(): void {
    this.watch?.controller.abort(new DOMException("watch-closed", "AbortError"));
    this.watch = null;
    this.cancelWork();
    this.selected.set(null); this.manifestUrl.set(""); this.playbackSessionId.set(""); this.opening.set(false); this.reconnecting.set(false);
  }

  private cancelWork(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.work?.abort(new DOMException("watch-work-cancelled", "AbortError"));
    this.work = null;
  }

  private current(watch: Watch, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.destroyed || this.watch !== watch) throw new DOMException("watch-superseded", "AbortError");
  }

  private schedule(watch: Watch, expiresAt: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.renew(watch); }, Math.max(1_000, expiresAt - Date.now() - 10_000));
  }

  private async renew(watch: Watch): Promise<void> {
    if (this.watch !== watch || this.reconnecting()) return;
    const controller = new AbortController();
    this.work = controller;
    const lifetime = AbortSignal.any([watch.controller.signal, controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const bootstrap = await this.directory.authorize(watch.programId, lifetime);
      this.current(watch, lifetime);
      if (this.isNewGeneration(watch, bootstrap)) {
        this.reconnecting.set(true);
        await this.installAuthorizedSession(watch, bootstrap, lifetime);
      } else {
        const session = await this.gateway.renew(watch.resourceRef, bootstrap.playbackGrant, lifetime);
        this.current(watch, lifetime);
        this.selected.set(bootstrap.program);
        this.schedule(watch, session.expiresAt);
      }
    } catch (error) {
      if (this.watch !== watch || controller.signal.aborted) return;
      if (watch.started && this.retryable(error)) await this.recover(watch);
      else await this.fail(watch, error);
    } finally {
      if (this.work === controller) { this.work = null; this.reconnecting.set(false); }
    }
  }

  private isNewGeneration(watch: Watch, bootstrap: BroadcastPlaybackBootstrap): boolean {
    const previous = this.selected(), next = bootstrap.program;
    if (!previous || !["live", "degraded"].includes(next.availability)
      || next.programId !== watch.programId || next.visibility !== previous.visibility
      || next.playback !== previous.playback || next.programEpoch < previous.programEpoch
      || next.policyRevision < previous.policyRevision) throw new Error("broadcast_playback_scope_changed");
    const newer = next.programEpoch > previous.programEpoch;
    if (newer ? bootstrap.resourceRef === watch.resourceRef || next.policyRevision <= previous.policyRevision
      : bootstrap.resourceRef !== watch.resourceRef || next.policyRevision !== previous.policyRevision) {
      throw new Error("broadcast_playback_scope_changed");
    }
    return newer;
  }

  private async installAuthorizedSession(watch: Watch, bootstrap: BroadcastPlaybackBootstrap, lifetime: AbortSignal): Promise<void> {
    watch.replacements = watch.replacements.filter((at) => at > Date.now() - 60_000);
    if (watch.replacements.length >= 3) throw new Error("broadcast_playback_generation_limit");
    const previousSessionId = this.playbackSessionId();
    await this.gateway.close();
    this.current(watch, lifetime);
    const session = await this.gateway.open(bootstrap.resourceRef, bootstrap.playbackGrant, lifetime);
    this.current(watch, lifetime);
    if (session.playbackSessionId === previousSessionId) throw new Error("broadcast_playback_scope_changed");
    watch.replacements.push(Date.now());
    watch.resourceRef = bootstrap.resourceRef;
    this.selected.set(bootstrap.program);
    this.manifestUrl.set(session.manifestUrl);
    this.playbackSessionId.set(session.playbackSessionId);
    this.reconnecting.set(false);
    this.errorCode.set("");
    this.schedule(watch, session.expiresAt);
  }

  private retryable(error: unknown): boolean {
    return error instanceof Error && ["broadcast_not_available", "broadcast_offline", "broadcast_playback_not_found"]
      .includes(error.message);
  }

  private async recover(watch: Watch): Promise<void> {
    if (this.watch !== watch || !watch.started) return;
    this.cancelWork();
    const controller = new AbortController();
    this.work = controller;
    const lifetime = AbortSignal.any([watch.controller.signal, controller.signal, AbortSignal.timeout(75_000)]);
    this.reconnecting.set(true);
    try {
      // Suspend media and retire the old cookie before any replacement authorization.
      await this.gateway.close();
      this.current(watch, lifetime);
      for (const delay of [0, 2_000, 5_000, 10_000, 20_000, 25_000]) {
        if (delay) await wait(delay, lifetime);
        this.current(watch, lifetime);
        try {
          const bootstrap = await this.directory.authorize(watch.programId, lifetime);
          this.current(watch, lifetime);
          // Fresh authority may confirm the exact same live output after a transient outage.
          // It may never silently widen its policy, roll back an epoch or reuse an old cookie.
          this.isNewGeneration(watch, bootstrap);
          await this.installAuthorizedSession(watch, bootstrap, lifetime);
          return;
        } catch (error) { if (!this.retryable(error)) throw error; }
      }
      throw new Error("broadcast_playback_reconnect_exhausted");
    } catch (error) { if (this.watch === watch && !controller.signal.aborted) await this.fail(watch, error); }
    finally { if (this.work === controller) { this.work = null; this.reconnecting.set(false); } }
  }

  private async fail(watch: Watch, error: unknown): Promise<void> {
    if (this.watch !== watch) return;
    this.clear();
    const code = error instanceof Error && ["broadcast_ended", "broadcast_playback_scope_changed",
      "broadcast_playback_generation_limit", "broadcast_temporarily_unavailable", "broadcast_directory_sign_in_required"]
      .includes(error.message) ? error.message : "broadcast_not_available";
    this.errorCode.set(code);
    try { await this.gateway.close(); } catch { /* No local playback survives; remote expiry remains the fallback. */ }
  }
}
