import { describe, expect, it, vi } from "vitest";

import { BroadcastCaptionSettingsService } from "./broadcast-caption-settings.service";

describe("BroadcastCaptionSettingsService", () => {
  it("requires each destination to be enabled explicitly and does not persist consent", () => {
    const service = new BroadcastCaptionSettingsService();
    expect(Object.values(service.consent()).every((value, index) => index === 0 || value === false)).toBe(true);
    expect(service.setDestination("broadcastTextTrack", true)).toBe(true);
    expect(service.consent().broadcastTextTrack).toBe(true);
    expect(service.consent().shareWithRoom).toBe(false);
    service.resetForSession();
    expect(service.consent().broadcastTextTrack).toBe(false);
  });

  it("accepts bounded language, delay, line, position and style updates", () => {
    const service = new BroadcastCaptionSettingsService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    expect(service.patchSettings({ language: "en-US", delayMs: 1_200, maximumLineLength: 36,
      positionPercent: 82, style: "large" })).toBe(true);
    expect(service.settings()).toEqual(expect.objectContaining({ language: "en-US", delayMs: 1_200,
      maximumLineLength: 36, positionPercent: 82, style: "large" }));
    expect(listener).toHaveBeenCalledWith(service.consent(), service.settings());
    unsubscribe();
    expect(service.patchSettings({ delayMs: 9_000 })).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
