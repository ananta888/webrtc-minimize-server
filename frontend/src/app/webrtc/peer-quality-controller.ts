import { MediaSource, QualitySettings, classifyLinkStats, stabilizeLinkClass } from "./media-optimization-policy";
import { RtpSenderMediaPolicy } from "./media-strategy.service";
import { ManagedPeer } from "./peer-connection-manager";

export interface PeerQualitySample {
  readonly availableOutgoingBitrate?: number;
  readonly roundTripTime?: number;
  readonly lossRatio?: number;
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
  async sample(peer: ManagedPeer, now = Date.now()): Promise<PeerQualitySample> {
    const reports = await peer.pc.getStats();
    let availableOutgoingBitrate: number | undefined;
    let roundTripTime: number | undefined;
    let lossRatio: number | undefined;
    reports.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) {
        if (Number.isFinite(report.availableOutgoingBitrate)) availableOutgoingBitrate = report.availableOutgoingBitrate;
        if (Number.isFinite(report.currentRoundTripTime)) roundTripTime = report.currentRoundTripTime;
      }
      if (report.type === "remote-inbound-rtp" && Number.isFinite(report.fractionLost)) {
        lossRatio = Math.max(lossRatio || 0, report.fractionLost);
      }
    });
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
    return { availableOutgoingBitrate, roundTripTime, lossRatio };
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
