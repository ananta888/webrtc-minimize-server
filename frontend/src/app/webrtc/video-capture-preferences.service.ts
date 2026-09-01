import { Injectable, computed, signal } from "@angular/core";

export type VideoCaptureSource = "camera" | "screen";

export interface VideoResolutionOption {
  readonly id: string;
  readonly label: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface VideoCapturePreference {
  readonly resolutionId: string;
  readonly frameRate: number;
}

export interface AppliedVideoSettings {
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
}

interface StoredVideoCapturePreferences {
  readonly version: 1;
  readonly camera: VideoCapturePreference;
  readonly screen: VideoCapturePreference;
  readonly screenAudioEnabled: boolean;
}

export const VIDEO_CAPTURE_STORAGE_KEY = "webrtc-video-capture-preferences-v1";

export const VIDEO_RESOLUTION_OPTIONS: readonly VideoResolutionOption[] = Object.freeze([
  Object.freeze({ id: "auto", label: "Automatisch", width: null, height: null }),
  Object.freeze({ id: "240p", label: "240p · 426 × 240", width: 426, height: 240 }),
  Object.freeze({ id: "360p", label: "360p · 640 × 360", width: 640, height: 360 }),
  Object.freeze({ id: "480p", label: "480p · 854 × 480", width: 854, height: 480 }),
  Object.freeze({ id: "540p", label: "540p · 960 × 540", width: 960, height: 540 }),
  Object.freeze({ id: "720p", label: "720p · 1280 × 720", width: 1280, height: 720 }),
  Object.freeze({ id: "900p", label: "900p · 1600 × 900", width: 1600, height: 900 }),
  Object.freeze({ id: "1080p", label: "1080p · 1920 × 1080", width: 1920, height: 1080 }),
  Object.freeze({ id: "1440p", label: "1440p · 2560 × 1440", width: 2560, height: 1440 }),
  Object.freeze({ id: "2160p", label: "2160p · 3840 × 2160", width: 3840, height: 2160 }),
]);

export const VIDEO_FRAME_RATE_OPTIONS: readonly number[] = Object.freeze([2, 5, 10, 15, 20, 24, 30, 60]);

const DEFAULT_PREFERENCES: StoredVideoCapturePreferences = Object.freeze({
  version: 1,
  camera: Object.freeze({ resolutionId: "auto", frameRate: 30 }),
  screen: Object.freeze({ resolutionId: "auto", frameRate: 30 }),
  screenAudioEnabled: false,
});

function validResolutionId(value: unknown): string {
  return typeof value === "string" && VIDEO_RESOLUTION_OPTIONS.some((option) => option.id === value)
    ? value
    : "auto";
}

function validFrameRate(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return VIDEO_FRAME_RATE_OPTIONS.includes(parsed) ? parsed : 30;
}

function normalizePreference(value: unknown): VideoCapturePreference {
  const candidate = value && typeof value === "object" ? value as Partial<VideoCapturePreference> : {};
  return Object.freeze({
    resolutionId: validResolutionId(candidate.resolutionId),
    frameRate: validFrameRate(candidate.frameRate),
  });
}

export function parseVideoCapturePreferences(value: string | null): StoredVideoCapturePreferences {
  if (!value) return DEFAULT_PREFERENCES;
  try {
    const candidate = JSON.parse(value) as Partial<StoredVideoCapturePreferences>;
    if (candidate.version !== 1) return DEFAULT_PREFERENCES;
    return Object.freeze({
      version: 1,
      camera: normalizePreference(candidate.camera),
      screen: normalizePreference(candidate.screen),
      screenAudioEnabled: candidate.screenAudioEnabled === true,
    });
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function createVideoCaptureConstraints(
  source: VideoCaptureSource,
  preference: VideoCapturePreference,
): MediaTrackConstraints {
  const resolution = VIDEO_RESOLUTION_OPTIONS.find((option) => option.id === preference.resolutionId)
    || VIDEO_RESOLUTION_OPTIONS[0];
  const frameRate = validFrameRate(preference.frameRate);
  const constraints: MediaTrackConstraints = {
    frameRate: { ideal: Math.min(source === "camera" ? 24 : 15, frameRate), max: frameRate },
  };
  if (resolution.width && resolution.height) {
    constraints.width = { ideal: resolution.width, max: resolution.width };
    constraints.height = { ideal: resolution.height, max: resolution.height };
  } else if (source === "camera") {
    constraints.width = { ideal: 1280, max: 1920 };
    constraints.height = { ideal: 720, max: 1080 };
  }
  return constraints;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 10) / 10
    : null;
}

export function normalizeAppliedVideoSettings(settings: MediaTrackSettings): AppliedVideoSettings {
  return Object.freeze({
    width: finitePositive(settings.width),
    height: finitePositive(settings.height),
    frameRate: finitePositive(settings.frameRate),
  });
}

export function appliedVideoSettingsLabel(settings: AppliedVideoSettings | null): string {
  if (!settings) return "Nicht aktiv";
  const resolution = settings.width && settings.height
    ? `${settings.width} × ${settings.height}`
    : "Auflösung vom Browser";
  const frameRate = settings.frameRate ? `${settings.frameRate} FPS` : "FPS vom Browser";
  return `${resolution} · ${frameRate}`;
}

@Injectable({ providedIn: "root" })
export class VideoCapturePreferencesService {
  readonly resolutionOptions = VIDEO_RESOLUTION_OPTIONS;
  readonly frameRateOptions = VIDEO_FRAME_RATE_OPTIONS;
  private readonly preferences = signal<StoredVideoCapturePreferences>(this.load());
  private readonly applied = {
    camera: signal<AppliedVideoSettings | null>(null),
    screen: signal<AppliedVideoSettings | null>(null),
  };
  readonly camera = computed(() => this.preferences().camera);
  readonly screen = computed(() => this.preferences().screen);
  readonly screenAudioEnabled = computed(() => this.preferences().screenAudioEnabled);
  readonly cameraAppliedLabel = computed(() => appliedVideoSettingsLabel(this.applied.camera()));
  readonly screenAppliedLabel = computed(() => appliedVideoSettingsLabel(this.applied.screen()));

  constraints(source: VideoCaptureSource): MediaTrackConstraints {
    return createVideoCaptureConstraints(source, this.preferences()[source]);
  }

  setResolution(source: VideoCaptureSource, resolutionId: unknown): void {
    this.update(source, {
      ...this.preferences()[source],
      resolutionId: validResolutionId(resolutionId),
    });
  }

  setFrameRate(source: VideoCaptureSource, frameRate: unknown): void {
    this.update(source, {
      ...this.preferences()[source],
      frameRate: validFrameRate(frameRate),
    });
  }

  setScreenAudioEnabled(enabled: unknown): void {
    this.store(Object.freeze({
      ...this.preferences(),
      screenAudioEnabled: enabled === true,
    }));
  }

  recordApplied(source: VideoCaptureSource, settings: MediaTrackSettings): void {
    this.applied[source].set(normalizeAppliedVideoSettings(settings));
  }

  clearApplied(source: VideoCaptureSource): void {
    this.applied[source].set(null);
  }

  private update(source: VideoCaptureSource, preference: VideoCapturePreference): void {
    const next: StoredVideoCapturePreferences = Object.freeze({
      ...this.preferences(),
      [source]: normalizePreference(preference),
    });
    this.store(next);
  }

  private store(next: StoredVideoCapturePreferences): void {
    this.preferences.set(next);
    try {
      localStorage.setItem(VIDEO_CAPTURE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts. In-memory preferences remain valid.
    }
  }

  private load(): StoredVideoCapturePreferences {
    try {
      return parseVideoCapturePreferences(localStorage.getItem(VIDEO_CAPTURE_STORAGE_KEY));
    } catch {
      return DEFAULT_PREFERENCES;
    }
  }
}
