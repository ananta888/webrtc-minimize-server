import { Injectable } from "@angular/core";

import { BroadcastBrowserPortError } from "./broadcast-ports";

const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const SESSION = /^pbs_[A-Za-z0-9_-]{24,64}$/;
const MANIFEST = /^\/broadcast\/play\/res_[A-Za-z0-9_-]{16,64}\/(?:index|master)\.m3u8$/;

export interface SecureBroadcastPlaybackSession {
  readonly playbackSessionId: string;
  readonly manifestUrl: string;
  readonly expiresAt: number;
}

async function parseSessionResponse(response: Response, resourceRef: string): Promise<SecureBroadcastPlaybackSession> {
  if (!response.ok) throw new BroadcastBrowserPortError(response.status === 429
    ? "broadcast_playback_session_quota_reached" : "broadcast_playback_not_found");
  let value: unknown;
  try { value = await response.json(); } catch { throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_response"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || Object.keys(value).some((key) => !new Set(["playbackSessionId", "manifestUrl", "expiresAt"]).has(key))) {
    throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_response");
  }
  const session = value as Record<string, unknown>;
  if (typeof session["playbackSessionId"] !== "string" || !SESSION.test(session["playbackSessionId"])
    || typeof session["manifestUrl"] !== "string" || !MANIFEST.test(session["manifestUrl"])
    || !session["manifestUrl"].startsWith(`/broadcast/play/${resourceRef}/`)
    || !Number.isSafeInteger(session["expiresAt"]) || Number(session["expiresAt"]) <= Date.now()) {
    throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_response");
  }
  return Object.freeze({
    playbackSessionId: String(session["playbackSessionId"]),
    manifestUrl: String(session["manifestUrl"]),
    expiresAt: Number(session["expiresAt"]),
  });
}

@Injectable({ providedIn: "root" })
export class BroadcastPlaybackGatewayService {
  private active: SecureBroadcastPlaybackSession | null = null;
  private pending: Readonly<{ controller: AbortController; signal: AbortSignal }> | null = null;
  private retiring: SecureBroadcastPlaybackSession | null = null;
  private closeTask: Promise<void> | null = null;

  private begin(signal: AbortSignal): NonNullable<BroadcastPlaybackGatewayService["pending"]> {
    signal.throwIfAborted();
    if (this.pending || this.closeTask || this.retiring) throw new BroadcastBrowserPortError("broadcast_playback_gateway_busy");
    const controller = new AbortController();
    const operation = Object.freeze({ controller, signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(15_000)]) });
    this.pending = operation;
    return operation;
  }

  private current(operation: NonNullable<BroadcastPlaybackGatewayService["pending"]>): void {
    operation.signal.throwIfAborted();
    if (this.pending !== operation) throw new DOMException("playback-superseded", "AbortError");
  }

  async open(resourceRef: string, playbackGrant: string, signal: AbortSignal): Promise<SecureBroadcastPlaybackSession> {
    if (this.active) throw new BroadcastBrowserPortError("broadcast_playback_gateway_busy");
    if (typeof resourceRef !== "string" || !RESOURCE.test(resourceRef) || typeof playbackGrant !== "string"
      || playbackGrant.length < 16 || playbackGrant.length > 8 * 1024
      || /[\u0000-\u001f\u007f]/.test(playbackGrant)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_request");
    }
    const operation = this.begin(signal);
    try {
    const response = await fetch("/api/broadcast/playback-sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${playbackGrant}`, "content-type": "application/json" },
      credentials: "same-origin",
      redirect: "error",
      signal: operation.signal,
      body: JSON.stringify({ resourceRef }),
    });
    const session = await parseSessionResponse(response, resourceRef);
    try { this.current(operation); }
    catch (error) {
      // A late response can only clean up its own exact handle, never the current one.
      if (this.session()?.playbackSessionId !== session.playbackSessionId) {
        try { await this.deleteSession(session); } catch { /* Remote revocation is unconfirmed; its grant still expires. */ }
      }
      throw error;
    }
    this.active = session;
    return session;
    } finally { if (this.pending === operation) this.pending = null; }
  }

  async renew(resourceRef: string, playbackGrant: string, signal: AbortSignal): Promise<SecureBroadcastPlaybackSession> {
    const active = this.active;
    if (!active || !RESOURCE.test(resourceRef) || !active.manifestUrl.includes(`/${resourceRef}/`)
      || typeof playbackGrant !== "string" || playbackGrant.length < 16 || playbackGrant.length > 8 * 1024
      || /[\u0000-\u001f\u007f]/.test(playbackGrant)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_request");
    }
    const operation = this.begin(signal);
    try {
    const response = await fetch(
      `/api/broadcast/playback-sessions/${encodeURIComponent(active.playbackSessionId)}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${playbackGrant}`, "content-type": "application/json" },
        credentials: "same-origin",
        redirect: "error",
        signal: operation.signal,
        body: JSON.stringify({ resourceRef }),
      },
    );
    const renewed = await parseSessionResponse(response, resourceRef);
    this.current(operation);
    if (renewed.playbackSessionId !== active.playbackSessionId || renewed.manifestUrl !== active.manifestUrl) {
      throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_response");
    }
    this.active = renewed;
    return renewed;
    } finally { if (this.pending === operation) this.pending = null; }
  }

  async close(): Promise<void> {
    this.pending?.controller.abort(new DOMException("playback-close", "AbortError"));
    this.pending = null;
    if (this.closeTask) return this.closeTask;
    this.retiring ||= this.active;
    this.active = null;
    const session = this.retiring;
    if (!session) return;
    const task = this.deleteSession(session);
    this.closeTask = task;
    try {
      await task;
      if (this.retiring === session) this.retiring = null;
    } finally { if (this.closeTask === task) this.closeTask = null; }
  }

  private async deleteSession(session: SecureBroadcastPlaybackSession): Promise<void> {
    const response = await fetch(`/api/broadcast/playback-sessions/${encodeURIComponent(session.playbackSessionId)}`, {
      method: "DELETE", credentials: "same-origin", redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new BroadcastBrowserPortError("broadcast_playback_gateway_close_failed");
    }
  }

  session(): SecureBroadcastPlaybackSession | null { return this.active; }
}
