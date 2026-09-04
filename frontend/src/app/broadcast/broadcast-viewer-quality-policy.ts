export type BroadcastViewerQualityMode = "auto" | "data-saver" | "low" | "medium" | "high";

export interface BroadcastViewerRendition {
  readonly index: number;
  readonly bitrate: number;
  readonly height: number;
}

export interface BroadcastViewerQualitySample {
  readonly sampledAt: number;
  readonly bandwidthEstimateBitsPerSecond: number;
  readonly bufferSeconds: number;
  readonly decodedFrames: number;
  readonly droppedFrames: number;
  readonly lowPowerMode: boolean;
}

export interface BroadcastViewerQualityDecision {
  readonly targetIndex: number;
  readonly reason: "manual" | "data-saver" | "bandwidth" | "buffer" | "decode" | "stable";
  readonly changed: boolean;
}

const MODE_HEIGHT_CEILING: Readonly<Record<Exclude<BroadcastViewerQualityMode, "auto">, number>> = Object.freeze({
  "data-saver": 360,
  low: 360,
  medium: 540,
  high: Number.MAX_SAFE_INTEGER,
});

export class BroadcastViewerQualityPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BroadcastViewerQualityPolicyError";
  }
}

const fail = (code: string): never => { throw new BroadcastViewerQualityPolicyError(code); };

function normalizedRenditions(values: readonly BroadcastViewerRendition[]): readonly BroadcastViewerRendition[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) fail("invalid_broadcast_renditions");
  const copy = values.map((value) => {
    if (!Number.isSafeInteger(value.index) || value.index < 0
      || !Number.isFinite(value.bitrate) || value.bitrate < 16_000 || value.bitrate > 50_000_000
      || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 4320) {
      return fail("invalid_broadcast_renditions");
    }
    return Object.freeze({ ...value });
  }).sort((left, right) => left.bitrate - right.bitrate || left.index - right.index);
  if (new Set(copy.map(({ index }) => index)).size !== copy.length) fail("invalid_broadcast_renditions");
  return Object.freeze(copy);
}

export class BroadcastViewerQualityPolicy {
  private currentIndex: number | null = null;
  private healthySamples = 0;
  private unhealthySamples = 0;
  private lastSwitchAt = 0;

  constructor(private mode: BroadcastViewerQualityMode = "auto") {}

  setMode(mode: BroadcastViewerQualityMode): void {
    if (!new Set(["auto", "data-saver", "low", "medium", "high"]).has(mode)) {
      fail("invalid_broadcast_quality_mode");
    }
    this.mode = mode;
    this.healthySamples = 0;
    this.unhealthySamples = 0;
  }

  evaluate(
    renditionValues: readonly BroadcastViewerRendition[],
    sample: BroadcastViewerQualitySample,
  ): BroadcastViewerQualityDecision {
    const renditions = normalizedRenditions(renditionValues);
    if (!sample || !Number.isSafeInteger(sample.sampledAt) || sample.sampledAt < 0
      || !Number.isFinite(sample.bandwidthEstimateBitsPerSecond)
      || sample.bandwidthEstimateBitsPerSecond < 0 || sample.bandwidthEstimateBitsPerSecond > 1_000_000_000
      || !Number.isFinite(sample.bufferSeconds) || sample.bufferSeconds < 0 || sample.bufferSeconds > 600
      || !Number.isSafeInteger(sample.decodedFrames) || sample.decodedFrames < 0
      || !Number.isSafeInteger(sample.droppedFrames) || sample.droppedFrames < 0
      || typeof sample.lowPowerMode !== "boolean") fail("invalid_broadcast_quality_sample");

    if (this.currentIndex === null || !renditions.some(({ index }) => index === this.currentIndex)) {
      this.currentIndex = renditions[0].index;
      this.lastSwitchAt = sample.sampledAt;
    }
    if (this.mode !== "auto") {
      const ceiling = MODE_HEIGHT_CEILING[this.mode];
      const candidates = renditions.filter(({ height }) => height <= ceiling);
      const target = (candidates.length ? candidates : renditions.slice(0, 1)).at(-1)!;
      const changed = target.index !== this.currentIndex;
      this.currentIndex = target.index;
      if (changed) this.lastSwitchAt = sample.sampledAt;
      return Object.freeze({
        targetIndex: target.index,
        reason: this.mode === "data-saver" ? "data-saver" : "manual",
        changed,
      });
    }

    const totalFrames = sample.decodedFrames + sample.droppedFrames;
    const droppedRatio = totalFrames > 0 ? sample.droppedFrames / totalFrames : 0;
    const currentPosition = Math.max(0, renditions.findIndex(({ index }) => index === this.currentIndex));
    const current = renditions[currentPosition];
    const bandwidthBudget = sample.bandwidthEstimateBitsPerSecond * 0.72;
    const decodeBad = totalFrames >= 30 && droppedRatio >= 0.08;
    const bufferBad = sample.bufferSeconds < 1.5;
    const bandwidthBad = sample.bandwidthEstimateBitsPerSecond > 0 && current.bitrate > bandwidthBudget;
    const unhealthy = decodeBad || bufferBad || bandwidthBad;
    this.unhealthySamples = unhealthy ? this.unhealthySamples + 1 : 0;
    this.healthySamples = unhealthy ? 0 : this.healthySamples + 1;

    if (unhealthy && this.unhealthySamples >= 2 && currentPosition > 0) {
      const target = renditions[currentPosition - 1];
      this.currentIndex = target.index;
      this.lastSwitchAt = sample.sampledAt;
      this.unhealthySamples = 0;
      return Object.freeze({
        targetIndex: target.index,
        reason: decodeBad ? "decode" : bufferBad ? "buffer" : "bandwidth",
        changed: true,
      });
    }

    const heldLongEnough = sample.sampledAt - this.lastSwitchAt >= 10_000;
    const next = renditions[currentPosition + 1];
    const powerAllows = !sample.lowPowerMode || (next?.height || 0) <= 540;
    const upgradeBudget = next && (sample.bandwidthEstimateBitsPerSecond === 0
      || next.bitrate <= sample.bandwidthEstimateBitsPerSecond * 0.62);
    if (!unhealthy && this.healthySamples >= 3 && heldLongEnough && next
      && powerAllows && upgradeBudget && sample.bufferSeconds >= 6) {
      this.currentIndex = next.index;
      this.lastSwitchAt = sample.sampledAt;
      this.healthySamples = 0;
      return Object.freeze({ targetIndex: next.index, reason: "stable", changed: true });
    }
    return Object.freeze({
      targetIndex: this.currentIndex,
      reason: decodeBad ? "decode" : bufferBad ? "buffer" : bandwidthBad ? "bandwidth" : "stable",
      changed: false,
    });
  }
}
