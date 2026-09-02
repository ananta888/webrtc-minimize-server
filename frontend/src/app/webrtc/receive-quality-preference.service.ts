import { Injectable, computed, signal } from "@angular/core";

import {
  RECEIVE_QUALITY_OPTIONS,
  ReceiveQualityProfile,
  isReceiveQualityProfile,
} from "./receive-quality-policy";

export const RECEIVE_QUALITY_STORAGE_KEY = "webrtc-receive-quality-profile-v1";
export const LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY = "webrtc-media-agent-layer-limit-v1";

export function parseReceiveQualityProfile(value: unknown): ReceiveQualityProfile {
  return isReceiveQualityProfile(value) ? value : "auto";
}

@Injectable({ providedIn: "root" })
export class ReceiveQualityPreferenceService {
  readonly options = RECEIVE_QUALITY_OPTIONS;
  private readonly state = signal<ReceiveQualityProfile>(this.load());
  readonly profile = this.state.asReadonly();
  readonly description = computed(() => (
    RECEIVE_QUALITY_OPTIONS.find(({ id }) => id === this.state())?.description || ""
  ));

  setProfile(value: unknown): boolean {
    if (!isReceiveQualityProfile(value)) return false;
    this.state.set(value);
    try {
      localStorage.setItem(RECEIVE_QUALITY_STORAGE_KEY, value);
      localStorage.removeItem(LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY);
    } catch { /* optional storage */ }
    return true;
  }

  private load(): ReceiveQualityProfile {
    try {
      const current = localStorage.getItem(RECEIVE_QUALITY_STORAGE_KEY);
      if (isReceiveQualityProfile(current)) {
        try { localStorage.removeItem(LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY); } catch { /* optional cleanup */ }
        return current;
      }
      const legacy = localStorage.getItem(LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY);
      const migrated = legacy === "low" || legacy === "medium" || legacy === "high" ? legacy : "auto";
      if (legacy !== null) {
        try {
          localStorage.setItem(RECEIVE_QUALITY_STORAGE_KEY, migrated);
          localStorage.removeItem(LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY);
        } catch { /* migration remains valid for this session */ }
      }
      return migrated;
    } catch { return "auto"; }
  }
}
