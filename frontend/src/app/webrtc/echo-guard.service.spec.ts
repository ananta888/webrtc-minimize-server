import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioActivityService } from "./audio-activity.service";
import { EchoGuardService } from "./echo-guard.service";
import { MediaPublicationService } from "./media-publication.service";
import { MediaStrategyService } from "./media-strategy.service";

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
} catch {
  // Already initialized
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

function buildService(overrides: {
  micActive?: boolean;
  aecMissing?: boolean;
  activePeerIds?: string[];
  micTrack?: { enabled: boolean };
} = {}) {
  const micTrack = overrides.micTrack ?? { enabled: true };
  const activity = {
    activePeerIds: signal(overrides.activePeerIds ?? []),
  };
  const media = {
    active: vi.fn(() => overrides.micActive ?? true),
    microphoneTrack: vi.fn(() => micTrack as unknown as MediaStreamTrack),
  };
  const strategy = {
    aecMissing: signal(overrides.aecMissing ?? true),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AudioActivityService, useValue: activity },
      { provide: MediaPublicationService, useValue: media },
      { provide: MediaStrategyService, useValue: strategy },
      {
        provide: EchoGuardService,
        useFactory: () => new EchoGuardService(
          activity as unknown as AudioActivityService,
          media as unknown as MediaPublicationService,
          strategy as unknown as MediaStrategyService,
        ),
      },
    ],
  });

  const service = TestBed.inject(EchoGuardService);
  return { service, activity, media, strategy, micTrack };
}

describe("EchoGuardService", () => {
  it("is disabled by default", () => {
    const { service } = buildService();
    expect(service.enabled()).toBe(false);
    expect(service.ducking()).toBe(false);
  });

  it("is available when mic is active and AEC is missing", () => {
    const { service } = buildService({ micActive: true, aecMissing: true });
    expect(service.available()).toBe(true);
  });

  it("is not available when AEC is active", () => {
    const { service } = buildService({ micActive: true, aecMissing: false });
    expect(service.available()).toBe(false);
  });

  it("is not available when mic is inactive", () => {
    const { service } = buildService({ micActive: false, aecMissing: true });
    expect(service.available()).toBe(false);
  });

  it("toggles enabled state", () => {
    const { service } = buildService();
    service.toggle();
    expect(service.enabled()).toBe(true);
    service.toggle();
    expect(service.enabled()).toBe(false);
  });

  it("ducks microphone when enabled, available, and remote is speaking", () => {
    const micTrack = { enabled: true };
    const { service, activity } = buildService({
      micActive: true,
      aecMissing: true,
      activePeerIds: [],
      micTrack,
    });

    service.toggle();
    activity.activePeerIds.set(["peer-1"]);
    TestBed.tick();

    expect(service.ducking()).toBe(true);
    expect(micTrack.enabled).toBe(false);
  });

  it("restores microphone when remote stops speaking", () => {
    const micTrack = { enabled: true };
    const { service, activity } = buildService({
      micActive: true,
      aecMissing: true,
      activePeerIds: ["peer-1"],
      micTrack,
    });

    service.toggle();
    TestBed.tick();
    expect(service.ducking()).toBe(true);
    expect(micTrack.enabled).toBe(false);

    activity.activePeerIds.set([]);
    TestBed.tick();
    expect(service.ducking()).toBe(false);
    expect(micTrack.enabled).toBe(true);
  });

  it("does not duck when disabled even if remote is speaking", () => {
    const micTrack = { enabled: true };
    const { service } = buildService({
      micActive: true,
      aecMissing: true,
      activePeerIds: ["peer-1"],
      micTrack,
    });

    // enabled is false by default
    TestBed.tick();
    expect(service.ducking()).toBe(false);
    expect(micTrack.enabled).toBe(true);
  });
});
