import { BroadcastBrowserPortError } from "./broadcast-ports";
import { WhipMediaTrackDescriptor } from "./whip-contracts";

export type WhipSenderQualityLevel = "low" | "medium" | "high";

export interface WhipSenderBinding {
  readonly descriptor: WhipMediaTrackDescriptor;
  readonly sender: RTCRtpSender;
}

export interface WhipSenderPolicy {
  readonly policyVersion: 1;
  readonly sampleIntervalMs: number;
  readonly cooldownMs: number;
  readonly degradeSamples: number;
  readonly recoverSamples: number;
  readonly degradePacketLoss: number;
  readonly recoverPacketLoss: number;
  readonly degradeRoundTripTime: number;
  readonly recoverRoundTripTime: number;
  readonly degradeEncodeUtilization: number;
  readonly recoverEncodeUtilization: number;
  readonly outgoingHeadroom: number;
}

export interface WhipAdaptationSample {
  readonly sampledAt: number;
  readonly level: WhipSenderQualityLevel;
  readonly transitioned: boolean;
  readonly packetLoss: number | null;
  readonly roundTripTime: number | null;
  readonly encodeUtilization: number | null;
  readonly availableOutgoingBitrate: number | null;
  readonly measuredOutgoingBitrate: number | null;
  readonly framesEncodedDelta: number | null;
  readonly reasonCode: string;
}

interface SenderEnvelope {
  readonly maximumBitrate: number;
  readonly maximumFramerate?: number;
  readonly degradationPreference?: RTCDegradationPreference;
  readonly priority: RTCPriorityType;
  readonly contentHint: string;
}

interface Counters {
  readonly sampledAt: number;
  readonly bytesSent: number;
  readonly packetsSent: number;
  readonly packetsLost: number;
  readonly framesEncoded: number;
  readonly totalEncodeTime: number;
}

const QUALITY_FACTOR: Readonly<Record<WhipSenderQualityLevel, number>> = Object.freeze({
  low: 0.35,
  medium: 0.65,
  high: 1,
});

const SOURCE_ENVELOPES: Readonly<Record<WhipMediaTrackDescriptor["sourceKind"], SenderEnvelope>> = Object.freeze({
  microphone: Object.freeze({ maximumBitrate: 48_000, priority: "high", contentHint: "speech" }),
  "screen-audio": Object.freeze({ maximumBitrate: 96_000, priority: "medium", contentHint: "speech" }),
  silence: Object.freeze({ maximumBitrate: 24_000, priority: "low", contentHint: "speech" }),
  "program-audio": Object.freeze({ maximumBitrate: 160_000, priority: "high", contentHint: "speech" }),
  camera: Object.freeze({
    maximumBitrate: 1_200_000,
    maximumFramerate: 24,
    degradationPreference: "balanced",
    priority: "medium",
    contentHint: "motion",
  }),
  screen: Object.freeze({
    maximumBitrate: 2_500_000,
    maximumFramerate: 15,
    degradationPreference: "maintain-resolution",
    priority: "high",
    contentHint: "detail",
  }),
  slate: Object.freeze({
    maximumBitrate: 180_000,
    maximumFramerate: 2,
    degradationPreference: "maintain-resolution",
    priority: "low",
    contentHint: "detail",
  }),
});

function sourceEnvelope(descriptor: WhipMediaTrackDescriptor): SenderEnvelope {
  if (descriptor.sourceKind !== "program-audio" || !descriptor.audioEncoding) {
    return SOURCE_ENVELOPES[descriptor.sourceKind];
  }
  return Object.freeze({
    maximumBitrate: descriptor.audioEncoding.opusBitsPerSecond,
    priority: descriptor.audioEncoding.priority,
    contentHint: descriptor.audioEncoding.contentHint,
  });
}

export const DEFAULT_WHIP_SENDER_POLICY: WhipSenderPolicy = Object.freeze({
  policyVersion: 1,
  sampleIntervalMs: 2_000,
  cooldownMs: 10_000,
  degradeSamples: 3,
  recoverSamples: 5,
  degradePacketLoss: 0.08,
  recoverPacketLoss: 0.025,
  degradeRoundTripTime: 0.35,
  recoverRoundTripTime: 0.15,
  degradeEncodeUtilization: 0.8,
  recoverEncodeUtilization: 0.55,
  outgoingHeadroom: 1.25,
});

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new BroadcastBrowserPortError("invalid_whip_sender_policy");
  }
  return Number(value);
}

function boundedRatio(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new BroadcastBrowserPortError("invalid_whip_sender_policy");
  }
  return value;
}

export function normalizeWhipSenderPolicy(value: WhipSenderPolicy): WhipSenderPolicy {
  if (!value || typeof value !== "object" || value.policyVersion !== 1
    || Object.keys(value).length !== 12
    || Object.keys(value).some((field) => !new Set([
      "policyVersion", "sampleIntervalMs", "cooldownMs", "degradeSamples", "recoverSamples",
      "degradePacketLoss", "recoverPacketLoss", "degradeRoundTripTime", "recoverRoundTripTime",
      "degradeEncodeUtilization", "recoverEncodeUtilization", "outgoingHeadroom",
    ]).has(field))) throw new BroadcastBrowserPortError("invalid_whip_sender_policy");
  const policy = Object.freeze({
    policyVersion: 1 as const,
    sampleIntervalMs: boundedInteger(value.sampleIntervalMs, 1_000, 30_000),
    cooldownMs: boundedInteger(value.cooldownMs, 2_000, 120_000),
    degradeSamples: boundedInteger(value.degradeSamples, 2, 10),
    recoverSamples: boundedInteger(value.recoverSamples, 3, 20),
    degradePacketLoss: boundedRatio(value.degradePacketLoss, 0.02, 0.5),
    recoverPacketLoss: boundedRatio(value.recoverPacketLoss, 0, 0.2),
    degradeRoundTripTime: boundedRatio(value.degradeRoundTripTime, 0.1, 3),
    recoverRoundTripTime: boundedRatio(value.recoverRoundTripTime, 0.02, 1),
    degradeEncodeUtilization: boundedRatio(value.degradeEncodeUtilization, 0.5, 4),
    recoverEncodeUtilization: boundedRatio(value.recoverEncodeUtilization, 0.1, 2),
    outgoingHeadroom: boundedRatio(value.outgoingHeadroom, 1.05, 3),
  });
  if (policy.recoverPacketLoss >= policy.degradePacketLoss
    || policy.recoverRoundTripTime >= policy.degradeRoundTripTime
    || policy.recoverEncodeUtilization >= policy.degradeEncodeUtilization) {
    throw new BroadcastBrowserPortError("invalid_whip_sender_policy");
  }
  return policy;
}

function reportValues(report: RTCStatsReport): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  report.forEach((entry) => values.push(entry as unknown as Record<string, unknown>));
  return values;
}

function maximum(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length ? Math.max(...usable) : null;
}

function minimum(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length ? Math.min(...usable) : null;
}

function nextLevel(level: WhipSenderQualityLevel, direction: "down" | "up"): WhipSenderQualityLevel {
  const levels: readonly WhipSenderQualityLevel[] = ["low", "medium", "high"];
  const index = levels.indexOf(level);
  return levels[Math.max(0, Math.min(levels.length - 1, index + (direction === "up" ? 1 : -1)))];
}

export class WhipAdaptiveSenderController {
  private readonly policy: WhipSenderPolicy;
  private bindings: readonly WhipSenderBinding[];
  private previous: Counters | null = null;
  private qualityLevel: WhipSenderQualityLevel = "high";
  private badSamples = 0;
  private goodSamples = 0;
  private lastTransitionAt = 0;
  private closed = false;
  private readonly configuredCaps = new WeakMap<RTCRtpSender, Readonly<{
    bitrates: readonly (number | null)[];
    frameRates: readonly (number | null)[];
    active: readonly boolean[];
  }>>();

  constructor(
    private readonly peerConnection: RTCPeerConnection,
    bindings: readonly WhipSenderBinding[],
    policy: WhipSenderPolicy = DEFAULT_WHIP_SENDER_POLICY,
    private readonly now: () => number = Date.now,
  ) {
    this.policy = normalizeWhipSenderPolicy(policy);
    this.bindings = Object.freeze([...bindings]);
    this.assertBindings(this.bindings);
    this.captureCaps(this.bindings);
  }

  get level(): WhipSenderQualityLevel {
    return this.qualityLevel;
  }

  get intervalMs(): number {
    return this.policy.sampleIntervalMs;
  }

  async apply(): Promise<boolean> {
    if (this.closed) return false;
    const results = await Promise.all(this.bindings.map((binding) => this.applyBinding(binding)));
    return results.every(Boolean);
  }

  async replaceBindings(bindings: readonly WhipSenderBinding[]): Promise<boolean> {
    if (this.closed) throw new BroadcastBrowserPortError("whip_sender_controller_closed");
    this.assertBindings(bindings);
    this.bindings = Object.freeze([...bindings]);
    this.captureCaps(this.bindings);
    this.previous = null;
    this.badSamples = 0;
    this.goodSamples = 0;
    return this.apply();
  }

  async sample(): Promise<WhipAdaptationSample> {
    if (this.closed) throw new BroadcastBrowserPortError("whip_sender_controller_closed");
    const sampledAt = this.now();
    const values = reportValues(await this.peerConnection.getStats());
    const outbound = values.filter((entry) => entry["type"] === "outbound-rtp" && entry["isRemote"] !== true);
    const remoteInbound = values.filter((entry) => entry["type"] === "remote-inbound-rtp");
    const candidatePairs = values.filter((entry) => entry["type"] === "candidate-pair"
      && (entry["nominated"] === true || entry["selected"] === true || entry["state"] === "succeeded"));
    const counters: Counters = {
      sampledAt,
      bytesSent: outbound.reduce((sum, entry) => sum + (finite(entry["bytesSent"]) || 0), 0),
      packetsSent: outbound.reduce((sum, entry) => sum + (finite(entry["packetsSent"]) || 0), 0),
      packetsLost: remoteInbound.reduce((sum, entry) => sum + (finite(entry["packetsLost"]) || 0), 0),
      framesEncoded: outbound.reduce((sum, entry) => sum + (finite(entry["framesEncoded"]) || 0), 0),
      totalEncodeTime: outbound.reduce((sum, entry) => sum + (finite(entry["totalEncodeTime"]) || 0), 0),
    };
    const roundTripTime = maximum([
      ...remoteInbound.map((entry) => finite(entry["roundTripTime"])),
      ...candidatePairs.map((entry) => finite(entry["currentRoundTripTime"])),
    ]);
    const availableOutgoingBitrate = minimum(candidatePairs.map(
      (entry) => finite(entry["availableOutgoingBitrate"]),
    ));
    const previous = this.previous;
    this.previous = counters;
    if (!previous || sampledAt <= previous.sampledAt) {
      return this.result(sampledAt, false, null, roundTripTime, null, availableOutgoingBitrate, null, null, "warming");
    }
    const seconds = (sampledAt - previous.sampledAt) / 1_000;
    const sent = Math.max(0, counters.packetsSent - previous.packetsSent);
    const lost = Math.max(0, counters.packetsLost - previous.packetsLost);
    const packetLoss = sent + lost > 0 ? lost / (sent + lost) : null;
    const measuredOutgoingBitrate = Math.max(0, counters.bytesSent - previous.bytesSent) * 8 / seconds;
    const encodeUtilization = Math.max(0, counters.totalEncodeTime - previous.totalEncodeTime) / seconds;
    const framesEncodedDelta = Math.max(0, counters.framesEncoded - previous.framesEncoded);
    const hasVideo = outbound.some((entry) => entry["kind"] === "video" || entry["mediaType"] === "video");
    const bad = (packetLoss !== null && packetLoss >= this.policy.degradePacketLoss)
      || (roundTripTime !== null && roundTripTime >= this.policy.degradeRoundTripTime)
      || encodeUtilization >= this.policy.degradeEncodeUtilization
      || (availableOutgoingBitrate !== null && measuredOutgoingBitrate > 50_000
        && availableOutgoingBitrate < measuredOutgoingBitrate * this.policy.outgoingHeadroom)
      || (hasVideo && measuredOutgoingBitrate > 50_000 && framesEncodedDelta === 0);
    const good = (packetLoss === null || packetLoss <= this.policy.recoverPacketLoss)
      && (roundTripTime === null || roundTripTime <= this.policy.recoverRoundTripTime)
      && encodeUtilization <= this.policy.recoverEncodeUtilization
      && (availableOutgoingBitrate === null || measuredOutgoingBitrate <= 50_000
        || availableOutgoingBitrate >= measuredOutgoingBitrate * this.policy.outgoingHeadroom)
      && (!hasVideo || framesEncodedDelta > 0);
    this.badSamples = bad ? this.badSamples + 1 : 0;
    this.goodSamples = !bad && good ? this.goodSamples + 1 : 0;
    let transitioned = false;
    let reasonCode = bad ? "constrained" : good ? "healthy" : "indeterminate";
    const cooldownElapsed = this.lastTransitionAt === 0
      || sampledAt - this.lastTransitionAt >= this.policy.cooldownMs;
    if (cooldownElapsed && this.badSamples >= this.policy.degradeSamples && this.qualityLevel !== "low") {
      this.qualityLevel = nextLevel(this.qualityLevel, "down");
      this.lastTransitionAt = sampledAt;
      this.badSamples = 0;
      this.goodSamples = 0;
      transitioned = true;
      reasonCode = "quality-reduced";
      await this.apply();
    } else if (cooldownElapsed && this.goodSamples >= this.policy.recoverSamples && this.qualityLevel !== "high") {
      this.qualityLevel = nextLevel(this.qualityLevel, "up");
      this.lastTransitionAt = sampledAt;
      this.badSamples = 0;
      this.goodSamples = 0;
      transitioned = true;
      reasonCode = "quality-recovered";
      await this.apply();
    }
    return this.result(
      sampledAt,
      transitioned,
      packetLoss,
      roundTripTime,
      encodeUtilization,
      availableOutgoingBitrate,
      measuredOutgoingBitrate,
      framesEncodedDelta,
      reasonCode,
    );
  }

  close(): void {
    this.closed = true;
    this.bindings = Object.freeze([]);
    this.previous = null;
  }

  private assertBindings(bindings: readonly WhipSenderBinding[]): void {
    if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 2
      || new Set(bindings.map(({ descriptor }) => descriptor.track.kind)).size !== bindings.length
      || bindings.some(({ descriptor, sender }) => !descriptor || !sender
        || typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function")) {
      throw new BroadcastBrowserPortError("invalid_whip_sender_bindings");
    }
  }

  private async applyBinding(binding: WhipSenderBinding): Promise<boolean> {
    const envelope = sourceEnvelope(binding.descriptor);
    try {
      binding.descriptor.track.contentHint = envelope.contentHint;
    } catch {
      // contentHint is best effort; sender ceilings remain authoritative.
    }
    for (const priorityMode of ["network", "local", "none"] as const) {
      const parameters = binding.sender.getParameters();
      if (!Array.isArray(parameters.encodings) || parameters.encodings.length < 1) return false;
      if (envelope.degradationPreference) parameters.degradationPreference = envelope.degradationPreference;
      const factor = QUALITY_FACTOR[this.qualityLevel];
      const weights = parameters.encodings.map((encoding) => {
        const scale = typeof encoding.scaleResolutionDownBy === "number"
          ? Math.max(1, encoding.scaleResolutionDownBy)
          : 1;
        return 1 / scale;
      });
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      const caps = this.configuredCaps.get(binding.sender);
      parameters.encodings.forEach((encoding, index) => {
        const minimumBitrate = binding.descriptor.track.kind === "audio" ? 20_000 : 10_000;
        encoding.active = caps?.active[index] !== false;
        const allocatedBitrate = Math.max(
          minimumBitrate,
          Math.round(envelope.maximumBitrate * factor * weights[index] / totalWeight),
        );
        encoding.maxBitrate = caps?.bitrates[index] === null || caps?.bitrates[index] === undefined
          ? allocatedBitrate
          : Math.min(allocatedBitrate, Number(caps.bitrates[index]));
        if (envelope.maximumFramerate) {
          const frameRate = Math.max(1, Math.round(envelope.maximumFramerate * factor));
          encoding.maxFramerate = caps?.frameRates[index] === null || caps?.frameRates[index] === undefined
            ? frameRate
            : Math.min(frameRate, Number(caps.frameRates[index]));
        }
        if (priorityMode !== "none") encoding.priority = envelope.priority;
        if (priorityMode === "network") encoding.networkPriority = envelope.priority;
      });
      try {
        await binding.sender.setParameters(parameters);
        return true;
      } catch {
        // Retry without non-portable priority extensions before declaring degradation.
      }
    }
    return false;
  }

  private captureCaps(bindings: readonly WhipSenderBinding[]): void {
    for (const { sender } of bindings) {
      if (this.configuredCaps.has(sender)) continue;
      const encodings = sender.getParameters().encodings || [];
      this.configuredCaps.set(sender, Object.freeze({
        bitrates: Object.freeze(encodings.map((encoding) => finite(encoding.maxBitrate))),
        frameRates: Object.freeze(encodings.map((encoding) => finite(encoding.maxFramerate))),
        active: Object.freeze(encodings.map((encoding) => encoding.active !== false)),
      }));
    }
  }

  private result(
    sampledAt: number,
    transitioned: boolean,
    packetLoss: number | null,
    roundTripTime: number | null,
    encodeUtilization: number | null,
    availableOutgoingBitrate: number | null,
    measuredOutgoingBitrate: number | null,
    framesEncodedDelta: number | null,
    reasonCode: string,
  ): WhipAdaptationSample {
    return Object.freeze({
      sampledAt,
      level: this.qualityLevel,
      transitioned,
      packetLoss,
      roundTripTime,
      encodeUtilization,
      availableOutgoingBitrate,
      measuredOutgoingBitrate,
      framesEncodedDelta,
      reasonCode,
    });
  }
}
