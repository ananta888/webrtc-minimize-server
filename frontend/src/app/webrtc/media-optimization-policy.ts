export type MediaSource = "microphone" | "camera" | "screen" | "screen-audio";
export type OptimizationMode = "auto" | "balanced" | "data-saver";
export type LinkClass = "unknown" | "good" | "constrained" | "critical";
export type VideoTier = "screen" | "focus" | "balanced" | "thumbnail" | "paused";

export interface ActivityObservation {
  readonly peerId: string;
  readonly level: number;
  readonly observedAt: number;
}

export interface QualitySettings {
  readonly tier: VideoTier;
  readonly active: boolean;
  readonly maxBitrate: number;
  readonly maxFramerate: number;
  readonly scaleResolutionDownBy: number;
}

export const QUALITY_SETTINGS: Readonly<Record<VideoTier, QualitySettings>> = Object.freeze({
  screen: Object.freeze({ tier: "screen", active: true, maxBitrate: 2_500_000, maxFramerate: 24, scaleResolutionDownBy: 1 }),
  focus: Object.freeze({ tier: "focus", active: true, maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 }),
  balanced: Object.freeze({ tier: "balanced", active: true, maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 2 }),
  thumbnail: Object.freeze({ tier: "thumbnail", active: true, maxBitrate: 90_000, maxFramerate: 3, scaleResolutionDownBy: 6 }),
  paused: Object.freeze({ tier: "paused", active: false, maxBitrate: 0, maxFramerate: 1, scaleResolutionDownBy: 8 }),
});

const VIDEO_TIERS: readonly VideoTier[] = ["screen", "focus", "balanced", "thumbnail", "paused"];
const SMALL_ROOM_CAMERA_FLOOR_PARTICIPANTS = 5;

export function selectActiveSpeakers(
  observations: readonly ActivityObservation[],
  previous: readonly string[],
  now: number,
  limit = 5,
): readonly string[] {
  const boundedLimit = Math.max(2, Math.min(5, Math.trunc(limit)));
  const previousRank = new Map(previous.map((peerId, index) => [peerId, index]));
  return observations
    .filter((item) => item.peerId && Number.isFinite(item.level) && now - item.observedAt <= 6_000)
    .map((item) => ({
      peerId: item.peerId,
      score: Math.max(0, Math.min(1, item.level))
        + (previousRank.has(item.peerId) && now - item.observedAt <= 4_000 ? 0.12 : 0),
      previousRank: previousRank.get(item.peerId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .filter((item) => item.score >= 0.035 || item.previousRank < boundedLimit)
    .sort((left, right) => right.score - left.score
      || left.previousRank - right.previousRank
      || left.peerId.localeCompare(right.peerId))
    .slice(0, boundedLimit)
    .map((item) => item.peerId);
}

function degrade(tier: VideoTier, steps: number): VideoTier {
  const index = VIDEO_TIERS.indexOf(tier);
  return VIDEO_TIERS[Math.min(VIDEO_TIERS.length - 1, index + steps)];
}

export function selectVideoQuality(input: Readonly<{
  source: MediaSource;
  speakerRank: number;
  participantCount: number;
  mode: OptimizationMode;
  linkClass: LinkClass;
  screenActive: boolean;
}>): QualitySettings {
  let tier: VideoTier;
  if (input.source === "screen") {
    tier = "screen";
  } else if (input.mode === "data-saver") {
    tier = input.speakerRank === 0 ? "balanced"
      : input.speakerRank > 0 && input.speakerRank < 3 ? "thumbnail" : "paused";
  } else if (input.speakerRank >= 0 && input.speakerRank < 2) {
    tier = "focus";
  } else if (input.speakerRank >= 2 && input.speakerRank < 5) {
    tier = "balanced";
  } else if (input.mode === "balanced") {
    tier = "thumbnail";
  } else {
    tier = input.participantCount > 8 ? "paused" : "thumbnail";
  }

  if (input.source === "camera" && input.screenActive) tier = degrade(tier, 1);
  if (input.linkClass === "constrained") tier = degrade(tier, 1);
  if (input.linkClass === "critical") tier = degrade(tier, 2);
  if (input.source === "camera"
    && input.participantCount > 0
    && input.participantCount <= SMALL_ROOM_CAMERA_FLOOR_PARTICIPANTS
    && input.mode !== "data-saver"
    && tier === "paused") tier = "thumbnail";
  return QUALITY_SETTINGS[tier];
}

export function classifyLinkStats(input: Readonly<{
  availableOutgoingBitrate?: number;
  roundTripTime?: number;
  lossRatio?: number;
}>): LinkClass {
  const bitrate = input.availableOutgoingBitrate;
  const rtt = input.roundTripTime;
  const loss = input.lossRatio;
  if ((bitrate !== undefined && bitrate < 250_000)
    || (rtt !== undefined && rtt > 0.6)
    || (loss !== undefined && loss > 0.12)) return "critical";
  if ((bitrate !== undefined && bitrate < 900_000)
    || (rtt !== undefined && rtt > 0.3)
    || (loss !== undefined && loss > 0.04)) return "constrained";
  if (bitrate === undefined && rtt === undefined && loss === undefined) return "unknown";
  return "good";
}

const LINK_SEVERITY: Readonly<Record<LinkClass, number>> = Object.freeze({
  good: 0,
  unknown: 1,
  constrained: 2,
  critical: 3,
});

export function stabilizeLinkClass(input: Readonly<{
  current: LinkClass;
  candidate: LinkClass;
  candidateSince: number;
  now: number;
  recoveryMs?: number;
}>): Readonly<{ value: LinkClass; candidateSince: number }> {
  if (input.candidate === input.current) return { value: input.current, candidateSince: input.now };
  if (LINK_SEVERITY[input.candidate] > LINK_SEVERITY[input.current]) {
    return { value: input.candidate, candidateSince: input.now };
  }
  const recoveryMs = input.recoveryMs ?? 6_000;
  if (input.now - input.candidateSince >= recoveryMs) {
    return { value: input.candidate, candidateSince: input.now };
  }
  return { value: input.current, candidateSince: input.candidateSince };
}
