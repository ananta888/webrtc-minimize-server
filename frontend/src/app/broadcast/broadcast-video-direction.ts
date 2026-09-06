import { InjectionToken } from "@angular/core";
import { BroadcastBrowserPortError, BroadcastCompositionHandle } from "./broadcast-ports";
import type { TrustedVideoLayout } from "./trusted-video-compositor";

export interface BroadcastVideoDirectionView {
  readonly version: 1;
  readonly compositionId: string;
  readonly revision: number;
  readonly layout: TrustedVideoLayout;
  readonly activeSourceId: string;
  readonly sources: readonly { readonly sourceId: string; readonly kind: "camera" | "screen" }[];
}

export interface BroadcastVideoDirectionRequest {
  readonly version: 1;
  readonly compositionId: string;
  readonly expectedRevision: number;
  readonly layout: TrustedVideoLayout;
  readonly activeSourceId: string;
}

/** Local presentation only. Cannot add sources, grant consent or select a writer. */
export interface BroadcastVideoDirectionPort {
  videoDirection(handle: BroadcastCompositionHandle): BroadcastVideoDirectionView | null;
  directVideo(handle: BroadcastCompositionHandle, request: BroadcastVideoDirectionRequest): BroadcastVideoDirectionView;
}

export const BROADCAST_VIDEO_DIRECTION_PORT = new InjectionToken<BroadcastVideoDirectionPort>("BROADCAST_VIDEO_DIRECTION_PORT");

export function validateVideoDirectionRequest(value: BroadcastVideoDirectionRequest): void {
  const fields = ["version", "compositionId", "expectedRevision", "layout", "activeSourceId"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.version !== 1 || typeof value.compositionId !== "string" || value.compositionId.length > 128
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || !["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"].includes(value.layout)
    || typeof value.activeSourceId !== "string" || value.activeSourceId.length > 128
    || (value.activeSourceId !== "" && value.layout !== "single" && value.layout !== "active-speaker")) {
    throw new BroadcastBrowserPortError("invalid_broadcast_video_direction");
  }
}
