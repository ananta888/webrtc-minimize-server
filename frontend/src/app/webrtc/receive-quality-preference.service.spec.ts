import { beforeEach, describe, expect, it } from "vitest";

import { QUALITY_SETTINGS } from "./media-optimization-policy";
import {
  capVideoQualityForReceiver,
  mediaAgentCameraLayerCeiling,
  receiveVideoEnabled,
} from "./receive-quality-policy";
import {
  LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY,
  RECEIVE_QUALITY_STORAGE_KEY,
  ReceiveQualityPreferenceService,
  parseReceiveQualityProfile,
} from "./receive-quality-preference.service";

describe("ReceiveQualityPreferenceService", () => {
  beforeEach(() => localStorage.clear());

  it("persists a general receive ceiling and rejects unknown values", () => {
    const service = new ReceiveQualityPreferenceService();
    expect(service.profile()).toBe("auto");
    expect(service.setProfile("low")).toBe(true);
    expect(service.profile()).toBe("low");
    expect(localStorage.getItem(RECEIVE_QUALITY_STORAGE_KEY)).toBe("low");
    expect(service.setProfile("ultra")).toBe(false);
    expect(service.profile()).toBe("low");
    expect(parseReceiveQualityProfile("audio-only")).toBe("audio-only");
    expect(parseReceiveQualityProfile({ profile: "low" })).toBe("auto");
  });

  it("migrates the previous agent-only camera limit without retaining two settings", () => {
    localStorage.setItem(LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY, "medium");
    const service = new ReceiveQualityPreferenceService();
    expect(service.profile()).toBe("medium");
    expect(localStorage.getItem(RECEIVE_QUALITY_STORAGE_KEY)).toBe("medium");
    expect(localStorage.getItem(LEGACY_MEDIA_AGENT_LAYER_STORAGE_KEY)).toBeNull();
  });

  it("only lowers direct camera and screen policies and never raises an adaptive choice", () => {
    expect(capVideoQualityForReceiver("camera", QUALITY_SETTINGS.focus, "low")).toEqual({
      tier: "thumbnail",
      active: true,
      maxBitrate: 120_000,
      maxFramerate: 6,
      scaleResolutionDownBy: 4,
    });
    expect(capVideoQualityForReceiver("screen", QUALITY_SETTINGS.screen, "medium")).toEqual({
      tier: "screen",
      active: true,
      maxBitrate: 1_200_000,
      maxFramerate: 12,
      scaleResolutionDownBy: 1,
    });
    expect(capVideoQualityForReceiver("camera", QUALITY_SETTINGS.thumbnail, "high"))
      .toEqual(QUALITY_SETTINGS.thumbnail);
    expect(capVideoQualityForReceiver("camera", QUALITY_SETTINGS.focus, "audio-only")).toEqual({
      tier: "paused",
      active: false,
      maxBitrate: 0,
      maxFramerate: 1,
      scaleResolutionDownBy: 8,
    });
  });

  it("maps the same preference to selective agent layers and audio-only video suppression", () => {
    expect(mediaAgentCameraLayerCeiling("auto")).toBe("high");
    expect(mediaAgentCameraLayerCeiling("low")).toBe("low");
    expect(mediaAgentCameraLayerCeiling("medium")).toBe("medium");
    expect(mediaAgentCameraLayerCeiling("high")).toBe("high");
    expect(receiveVideoEnabled("audio-only")).toBe(false);
    expect(receiveVideoEnabled("low")).toBe(true);
  });
});
