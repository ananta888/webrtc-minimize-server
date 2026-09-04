import { Injectable, signal } from "@angular/core";

import {
  BroadcastCaptionConsent,
  BroadcastCaptionSettings,
  DEFAULT_BROADCAST_CAPTION_CONSENT,
  DEFAULT_BROADCAST_CAPTION_SETTINGS,
  normalizeBroadcastCaptionConsent,
  normalizeBroadcastCaptionSettings,
} from "./broadcast-caption-packager";

export type BroadcastCaptionDestination = keyof Pick<
  BroadcastCaptionConsent,
  "localOverlay" | "shareWithRoom" | "broadcastTextTrack" | "broadcastBurnIn"
>;

@Injectable({ providedIn: "root" })
export class BroadcastCaptionSettingsService {
  readonly consent = signal<BroadcastCaptionConsent>(DEFAULT_BROADCAST_CAPTION_CONSENT);
  readonly settings = signal<BroadcastCaptionSettings>(DEFAULT_BROADCAST_CAPTION_SETTINGS);
  private readonly listeners = new Set<(consent: BroadcastCaptionConsent, settings: BroadcastCaptionSettings) => void>();

  setDestination(destination: BroadcastCaptionDestination, enabled: unknown): boolean {
    if (!new Set<BroadcastCaptionDestination>([
      "localOverlay", "shareWithRoom", "broadcastTextTrack", "broadcastBurnIn",
    ]).has(destination)) return false;
    const next = normalizeBroadcastCaptionConsent({ ...this.consent(), [destination]: enabled === true });
    if (!next) return false;
    this.consent.set(next);
    this.notify();
    return true;
  }

  patchSettings(patch: Partial<BroadcastCaptionSettings>): boolean {
    const next = normalizeBroadcastCaptionSettings({ ...this.settings(), ...patch });
    if (!next) return false;
    this.settings.set(next);
    this.notify();
    return true;
  }

  resetForSession(): void {
    this.consent.set(DEFAULT_BROADCAST_CAPTION_CONSENT);
    this.settings.set(DEFAULT_BROADCAST_CAPTION_SETTINGS);
    this.notify();
  }

  subscribe(listener: (consent: BroadcastCaptionConsent, settings: BroadcastCaptionSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(this.consent(), this.settings()); } catch { /* A local output cannot prevent consent updates. */ }
    }
  }
}
