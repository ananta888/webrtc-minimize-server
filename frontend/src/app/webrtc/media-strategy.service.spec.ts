import { beforeEach, describe, expect, it } from "vitest";

import { QUALITY_SETTINGS } from "./media-optimization-policy";
import {
  MEDIA_STRATEGY_STORAGE_KEY,
  MediaStrategyService,
  appliedAudioSettingsLabel,
  normalizeAppliedAudioSettings,
  parseMediaStrategy,
} from "./media-strategy.service";

describe("MediaStrategyService", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("starts with the safe conversation preset and offers distinct standard strategies", () => {
    const service = new MediaStrategyService();
    expect(service.presetId()).toBe("conversation");
    expect(service.audioProfile()).toBe("speech-clear");
    expect(service.optimizationMode()).toBe("auto");
    expect(service.priorityOrder()).toEqual(["microphone", "camera", "screen"]);
    expect(service.presetOptions.filter((option) => option.id !== "custom")).toHaveLength(6);

    service.selectPreset("presentation");
    expect(service.priorityOrder()).toEqual(["screen", "microphone", "camera"]);
    expect(service.priority("screen")).toBe("high");
    expect(service.priority("microphone")).toBe("medium");

    service.selectPreset("data-saver");
    expect(service.audioProfile()).toBe("speech-low");
    expect(service.optimizationMode()).toBe("data-saver");
    expect(service.senderPolicy("microphone")).toEqual({ priority: "high", maxBitrate: 24_000 });
  });

  it("normalizes persisted custom values and never permits duplicate or missing priorities", () => {
    const parsed = parseMediaStrategy(JSON.stringify({
      version: 1,
      presetId: "custom",
      audioProfile: "invalid",
      optimizationMode: "turbo",
      priorityOrder: ["screen", "screen", "unknown"],
    }));
    expect(parsed).toEqual({
      version: 1,
      presetId: "custom",
      audioProfile: "speech-clear",
      optimizationMode: "auto",
      priorityOrder: ["screen", "microphone", "camera"],
    });
    expect(parseMediaStrategy("not-json").presetId).toBe("conversation");

    const service = new MediaStrategyService();
    service.setPriorityAt(0, "screen");
    expect(service.presetId()).toBe("custom");
    expect(service.priorityOrder()).toEqual(["screen", "camera", "microphone"]);
    service.setPriorityAt(2, "camera");
    expect(service.priorityOrder()).toEqual(["screen", "microphone", "camera"]);
    expect(new Set(service.priorityOrder()).size).toBe(3);
    expect(JSON.parse(localStorage.getItem(MEDIA_STRATEGY_STORAGE_KEY) || "{}").priorityOrder)
      .toEqual(["screen", "microphone", "camera"]);
  });

  it("builds best-effort speech and music constraints and reports actual browser settings", () => {
    const service = new MediaStrategyService();
    expect(service.audioConstraints()).toEqual({
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    service.setAudioProfile("music");
    expect(service.audioConstraints()).toEqual({
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(service.senderPolicy("screen-audio")).toEqual({ priority: "low", maxBitrate: 128_000 });

    const actual = normalizeAppliedAudioSettings({
      sampleRate: 48_000,
      sampleSize: 16,
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(appliedAudioSettingsLabel(actual))
      .toBe("48 kHz · 2 Kanäle · 16 Bit · Echo aus · Rauschfilter aus · Pegelautomatik aus");
    service.recordAppliedAudio({ sampleRate: 44_100, channelCount: 1, echoCancellation: true });
    expect(service.appliedAudioLabel()).toBe("44100 Hz · 1 Kanal · Echo an");
    service.clearAppliedAudio();
    expect(service.appliedAudioLabel()).toBe("Nicht aktiv");
  });

  it("combines relative priority with deterministic video bitrate and FPS ceilings", () => {
    const service = new MediaStrategyService();
    expect(service.prioritizeVideo("camera", QUALITY_SETTINGS.focus)).toEqual({
      ...QUALITY_SETTINGS.focus,
      maxBitrate: 864_000,
      maxFramerate: 15,
    });
    expect(service.prioritizeVideo("screen", QUALITY_SETTINGS.screen)).toEqual({
      ...QUALITY_SETTINGS.screen,
      maxBitrate: 1_125_000,
      maxFramerate: 10,
    });
    service.selectPreset("presentation");
    expect(service.prioritizeVideo("screen", QUALITY_SETTINGS.screen)).toEqual(QUALITY_SETTINGS.screen);
    expect(service.prioritizeVideo("camera", QUALITY_SETTINGS.paused)).toEqual(QUALITY_SETTINGS.paused);
  });
});
