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

@Injectable({ providedIn: "root" })
export class BroadcastPlaybackGatewayService {
  private active: SecureBroadcastPlaybackSession | null = null;

  async open(resourceRef: string, playbackGrant: string, signal: AbortSignal): Promise<SecureBroadcastPlaybackSession> {
    if (this.active) throw new BroadcastBrowserPortError("broadcast_playback_gateway_busy");
    if (!RESOURCE.test(resourceRef) || typeof playbackGrant !== "string"
      || playbackGrant.length < 16 || playbackGrant.length > 8 * 1024
      || /[\u0000-\u001f\u007f]/.test(playbackGrant)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_request");
    }
    const response = await fetch("/api/broadcast/playback-sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${playbackGrant}`, "content-type": "application/json" },
      credentials: "same-origin",
      redirect: "error",
      signal,
      body: JSON.stringify({ resourceRef }),
    });
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
    if (!SESSION.test(String(session["playbackSessionId"] || ""))
      || !MANIFEST.test(String(session["manifestUrl"] || ""))
      || !Number.isSafeInteger(session["expiresAt"]) || Number(session["expiresAt"]) <= Date.now()) {
      throw new BroadcastBrowserPortError("invalid_broadcast_playback_gateway_response");
    }
    this.active = Object.freeze({
      playbackSessionId: String(session["playbackSessionId"]),
      manifestUrl: String(session["manifestUrl"]),
      expiresAt: Number(session["expiresAt"]),
    });
    return this.active;
  }

  async close(): Promise<void> {
    const session = this.active;
    if (!session) return;
    const response = await fetch(`/api/broadcast/playback-sessions/${encodeURIComponent(session.playbackSessionId)}`, {
      method: "DELETE", credentials: "same-origin", redirect: "error",
    });
    if (!response.ok && response.status !== 404) {
      throw new BroadcastBrowserPortError("broadcast_playback_gateway_close_failed");
    }
    this.active = null;
  }

  session(): SecureBroadcastPlaybackSession | null { return this.active; }
}
