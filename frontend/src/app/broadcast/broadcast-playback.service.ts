import { Inject, Injectable, OnDestroy, signal } from "@angular/core";

import {
  BROADCAST_PLAYBACK_PORT,
  BroadcastBrowserPortError,
  BroadcastPlaybackPort,
  BroadcastPlaybackRequest,
  BroadcastPlaybackSession,
} from "./broadcast-ports";
import { normalizeBroadcastPlaybackRequest } from "./broadcast-browser-validation";

type PlaybackLifecycle = "idle" | "opening" | "playing" | "closing" | "failed";

@Injectable()
export class BroadcastPlaybackService implements OnDestroy {
  readonly panelVisible = signal(false);
  readonly lifecycle = signal<PlaybackLifecycle>("idle");
  readonly errorCode = signal("");
  readonly session = signal<BroadcastPlaybackSession | null>(null);
  private controller: AbortController | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    @Inject(BROADCAST_PLAYBACK_PORT) private readonly playback: BroadcastPlaybackPort,
  ) {}

  setPanelVisible(visible: boolean): void {
    this.panelVisible.set(visible);
  }

  async open(request: BroadcastPlaybackRequest): Promise<void> {
    if (this.destroyed) throw new BroadcastBrowserPortError("broadcast_playback_destroyed");
    const normalizedRequest = normalizeBroadcastPlaybackRequest(request);
    if (this.opening || this.closing || this.session()) {
      throw new BroadcastBrowserPortError("broadcast_playback_busy");
    }
    this.lifecycle.set("opening");
    this.errorCode.set("");
    this.controller = new AbortController();
    const task = this.openWithPort(normalizedRequest, this.controller.signal);
    this.opening = task;
    try {
      await task;
    } finally {
      if (this.opening === task) this.opening = null;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const task = this.closeWithPort();
    this.closing = task;
    try {
      await task;
    } finally {
      if (this.closing === task) this.closing = null;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    try {
      await this.close();
    } finally {
      this.panelVisible.set(false);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    void this.close();
  }

  private async openWithPort(request: BroadcastPlaybackRequest, signal: AbortSignal): Promise<void> {
    try {
      const session = await this.playback.open(request, signal);
      if (signal.aborted) {
        await this.playback.close(session);
        signal.throwIfAborted();
      }
      if (!session || session.programId !== request.programId
        || session.programEpoch !== request.programEpoch
        || typeof session.playbackSessionId !== "string"
        || session.playbackSessionId.length < 8
        || session.playbackSessionId.length > 128) {
        if (session) {
          try {
            await this.playback.close(session);
          } catch {
            // An invalid adapter result remains the primary fail-closed error.
          }
        }
        throw new BroadcastBrowserPortError("invalid_broadcast_playback_session");
      }
      this.session.set(Object.freeze({ ...session }));
      this.lifecycle.set("playing");
    } catch (error) {
      this.session.set(null);
      if (signal.aborted) {
        this.lifecycle.set("idle");
      } else {
        this.lifecycle.set("failed");
        this.errorCode.set(error instanceof Error ? error.message : "broadcast_playback_failed");
      }
      throw error;
    } finally {
      if (this.controller?.signal === signal) this.controller = null;
    }
  }

  private async closeWithPort(): Promise<void> {
    this.controller?.abort(new DOMException("close", "AbortError"));
    this.lifecycle.set(this.session() || this.opening ? "closing" : "idle");
    if (this.opening) {
      try {
        await this.opening;
      } catch {
        // The opening path already closed a late session when its signal was aborted.
      }
    }
    const session = this.session();
    try {
      if (session) await this.playback.close(session);
      this.session.set(null);
      this.lifecycle.set("idle");
      this.errorCode.set("");
    } catch (error) {
      this.lifecycle.set("failed");
      this.errorCode.set(error instanceof Error && error.message
        ? error.message
        : "broadcast_playback_close_failed");
      throw error;
    }
  }
}
