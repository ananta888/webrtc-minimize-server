import { MediaSource, QualitySettings, classifyLinkStats, stabilizeLinkClass } from "./media-optimization-policy";
import { MeshTrafficCounters } from "./mesh-analysis.service";
import { RtpSenderMediaPolicy } from "./media-strategy.service";
import { ManagedPeer } from "./peer-connection-manager";

export interface PeerQualitySample {
  readonly availableOutgoingBitrate?: number;
  readonly roundTripTime?: number;
  readonly lossRatio?: number;
  readonly trafficCounters: MeshTrafficCounters;
}

type StatsValue = RTCStats & Record<string, unknown>;

function byteCounter(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number)) : null;
}

function statsString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface ParameterApplication {
  readonly applied: boolean;
  readonly capability: "available" | "degraded";
}

const SIMULCAST_LAYER_RANK: Readonly<Record<string, number>> = Object.freeze({ q: 0, h: 1, f: 2 });

function videoTierRank(tier: QualitySettings["tier"]): number {
  if (tier === "screen" || tier === "focus") return 2;
  if (tier === "balanced") return 1;
  if (tier === "thumbnail") return 0;
  return -1;
}

export class PeerQualityController {
  async sample(
    peer: ManagedPeer,
    now = Date.now(),
    trackSources: ReadonlyMap<string, MediaSource> = new Map(),
  ): Promise<PeerQualitySample> {
    const reports = await peer.pc.getStats();
    const values: StatsValue[] = [];
    reports.forEach((report) => values.push(report as StatsValue));
    const byId = new Map(values.map((report) => [report.id, report]));
    let availableOutgoingBitrate: number | undefined;
    let roundTripTime: number | undefined;
    let lossRatio: number | undefined;
    const candidatePairs: StatsValue[] = [];
    const transportSelectedPairIds = new Set<string>();
    let transportOutgoingBytes = 0;
    let transportIncomingBytes = 0;
    let transportCounters = 0;
    let audioOutgoingBytes = 0;
    let audioIncomingBytes = 0;
    let videoOutgoingBytes = 0;
    let videoIncomingBytes = 0;
    let screenOutgoingBytes = 0;
    let screenIncomingBytes = 0;
    let dataOutgoingBytes = 0;
    let dataIncomingBytes = 0;
    for (const report of values) {
      if (report.type === "candidate-pair" && report["state"] === "succeeded"
        && (report["nominated"] || report["selected"])) {
        candidatePairs.push(report);
      }
      if (report.type === "remote-inbound-rtp" && Number.isFinite(report["fractionLost"])) {
        lossRatio = Math.max(lossRatio || 0, Number(report["fractionLost"]));
      }
      if (report.type === "transport") {
        const selectedCandidatePairId = statsString(report["selectedCandidatePairId"]);
        if (selectedCandidatePairId) transportSelectedPairIds.add(selectedCandidatePairId);
        const outgoing = byteCounter(report["bytesSent"]);
        const incoming = byteCounter(report["bytesReceived"]);
        if (outgoing !== null && incoming !== null) {
          transportOutgoingBytes += outgoing;
          transportIncomingBytes += incoming;
          transportCounters += 1;
        }
      }
      if (report.type === "data-channel") {
        dataOutgoingBytes += byteCounter(report["bytesSent"]) || 0;
        dataIncomingBytes += byteCounter(report["bytesReceived"]) || 0;
      }
      if (report.type !== "outbound-rtp" && report.type !== "inbound-rtp") continue;
      const outgoing = report.type === "outbound-rtp";
      const bytes = byteCounter(report[outgoing ? "bytesSent" : "bytesReceived"]);
      if (bytes === null) continue;
      const linkedTrack = byId.get(statsString(report["trackId"]))
        || byId.get(statsString(report["mediaSourceId"]));
      const trackIdentifier = statsString(report["trackIdentifier"])
        || statsString(linkedTrack?.["trackIdentifier"]);
      const kind = statsString(report["kind"]) || statsString(report["mediaType"])
        || statsString(linkedTrack?.["kind"]);
      if (kind === "audio") {
        if (outgoing) audioOutgoingBytes += bytes; else audioIncomingBytes += bytes;
      } else if (kind === "video" && trackSources.get(trackIdentifier) === "screen") {
        if (outgoing) screenOutgoingBytes += bytes; else screenIncomingBytes += bytes;
      } else if (kind === "video") {
        if (outgoing) videoOutgoingBytes += bytes; else videoIncomingBytes += bytes;
      }
    }
    const pair = candidatePairs.sort((left, right) => {
      const transportDifference = Number(transportSelectedPairIds.has(right.id))
        - Number(transportSelectedPairIds.has(left.id));
      if (transportDifference !== 0) return transportDifference;
      const selectedDifference = Number(Boolean(right["selected"])) - Number(Boolean(left["selected"]));
      if (selectedDifference !== 0) return selectedDifference;
      const rightBytes = (byteCounter(right["bytesSent"]) || 0) + (byteCounter(right["bytesReceived"]) || 0);
      const leftBytes = (byteCounter(left["bytesSent"]) || 0) + (byteCounter(left["bytesReceived"]) || 0);
      return rightBytes - leftBytes;
    })[0] || null;
    if (Number.isFinite(pair?.["availableOutgoingBitrate"])) {
      availableOutgoingBitrate = Number(pair?.["availableOutgoingBitrate"]);
    }
    if (Number.isFinite(pair?.["currentRoundTripTime"])) {
      roundTripTime = Number(pair?.["currentRoundTripTime"]);
    }
    const pairOutgoingBytes = byteCounter(pair?.["bytesSent"]);
    const pairIncomingBytes = byteCounter(pair?.["bytesReceived"]);
    const categorizedOutgoing = audioOutgoingBytes + videoOutgoingBytes + screenOutgoingBytes + dataOutgoingBytes;
    const categorizedIncoming = audioIncomingBytes + videoIncomingBytes + screenIncomingBytes + dataIncomingBytes;
    const outgoingBytes = Math.max(
      categorizedOutgoing,
      pairOutgoingBytes ?? (transportCounters > 0 ? transportOutgoingBytes : categorizedOutgoing),
    );
    const incomingBytes = Math.max(
      categorizedIncoming,
      pairIncomingBytes ?? (transportCounters > 0 ? transportIncomingBytes : categorizedIncoming),
    );
    const candidate = classifyLinkStats({ availableOutgoingBitrate, roundTripTime, lossRatio });
    if (candidate !== peer.linkCandidate) {
      peer.linkCandidate = candidate;
      peer.linkCandidateSince = now;
    }
    const stable = stabilizeLinkClass({
      current: peer.linkClass,
      candidate,
      candidateSince: peer.linkCandidateSince,
      now,
    });
    peer.linkClass = stable.value;
    peer.linkCandidateSince = stable.candidateSince;
    return {
      availableOutgoingBitrate,
      roundTripTime,
      lossRatio,
      trafficCounters: Object.freeze({
        sampledAt: now,
        outgoingBytes,
        incomingBytes,
        audioOutgoingBytes,
        audioIncomingBytes,
        videoOutgoingBytes,
        videoIncomingBytes,
        screenOutgoingBytes,
        screenIncomingBytes,
        dataOutgoingBytes,
        dataIncomingBytes,
      }),
    };
  }

  async applyAudio(
    peer: ManagedPeer,
    publicationId: string,
    sender: RTCRtpSender,
    policy: RtpSenderMediaPolicy,
    force: boolean,
  ): Promise<"available" | "degraded" | null> {
    const signature = `audio:${policy.maxBitrate}:${policy.priority}`;
    if (!force && peer.appliedTiers.get(publicationId) === signature) return null;
    const result = await this.applyParameters(sender, policy.priority, (parameters) => {
      parameters.encodings[0].active = true;
      parameters.encodings[0].maxBitrate = Math.max(20_000, policy.maxBitrate);
    });
    if (result.applied) peer.appliedTiers.set(publicationId, signature);
    return result.capability;
  }

  async applyVideo(
    peer: ManagedPeer,
    publicationId: string,
    sender: RTCRtpSender,
    source: MediaSource,
    quality: QualitySettings,
    priority: RTCPriorityType,
    force: boolean,
  ): Promise<"available" | "degraded" | null> {
    const signature = `${quality.tier}:${quality.maxBitrate}:${quality.maxFramerate}:${quality.scaleResolutionDownBy}:${priority}`;
    if (!force && peer.appliedTiers.get(publicationId) === signature) return null;
    const result = await this.applyParameters(sender, priority, (parameters) => {
      parameters.degradationPreference = source === "screen" ? "maintain-resolution" : "balanced";
      const simulcast = source === "camera" && parameters.encodings.length > 1
        && parameters.encodings.every(({ rid }) => rid && Object.hasOwn(SIMULCAST_LAYER_RANK, rid));
      if (simulcast) {
        const targetRank = videoTierRank(quality.tier);
        const layerPolicy = {
          q: { maxBitrate: 120_000, maxFramerate: 6, scaleResolutionDownBy: 4 },
          h: { maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
          f: { maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
        } as const;
        for (const encoding of parameters.encodings) {
          const rid = encoding.rid as keyof typeof layerPolicy;
          const policy = layerPolicy[rid];
          encoding.active = quality.active && SIMULCAST_LAYER_RANK[rid] <= targetRank;
          encoding.maxBitrate = Math.max(1, Math.min(policy.maxBitrate, quality.maxBitrate));
          encoding.maxFramerate = Math.max(1, Math.min(policy.maxFramerate, quality.maxFramerate));
          encoding.scaleResolutionDownBy = policy.scaleResolutionDownBy;
        }
      } else {
        parameters.encodings[0].active = quality.active;
        parameters.encodings[0].maxBitrate = Math.max(1, quality.maxBitrate);
        parameters.encodings[0].maxFramerate = quality.maxFramerate;
        parameters.encodings[0].scaleResolutionDownBy = quality.scaleResolutionDownBy;
      }
    });
    if (result.applied) peer.appliedTiers.set(publicationId, signature);
    return result.capability;
  }

  private async applyParameters(
    sender: RTCRtpSender,
    priority: RTCPriorityType,
    configure: (parameters: RTCRtpSendParameters) => void,
  ): Promise<ParameterApplication> {
    for (const prioritySupport of ["network", "local", "none"] as const) {
      const parameters = sender.getParameters();
      if (parameters.encodings.length === 0) return { applied: false, capability: "degraded" };
      configure(parameters);
      for (const encoding of parameters.encodings) {
        if (prioritySupport !== "none") encoding.priority = priority;
        if (prioritySupport === "network") encoding.networkPriority = priority;
      }
      try {
        await sender.setParameters(parameters);
        return {
          applied: true,
          capability: prioritySupport === "network" ? "available" : "degraded",
        };
      } catch {
        // Some browsers implement sender ceilings but reject one or both priority extensions.
      }
    }
    return { applied: false, capability: "degraded" };
  }
}
