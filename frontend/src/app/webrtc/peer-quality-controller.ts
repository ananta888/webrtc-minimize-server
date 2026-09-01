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
      parameters.encodings[0].active = quality.active;
      parameters.encodings[0].maxBitrate = Math.max(1, quality.maxBitrate);
      parameters.encodings[0].maxFramerate = quality.maxFramerate;
      parameters.encodings[0].scaleResolutionDownBy = quality.scaleResolutionDownBy;
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
      if (prioritySupport !== "none") parameters.encodings[0].priority = priority;
      if (prioritySupport === "network") parameters.encodings[0].networkPriority = priority;
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
