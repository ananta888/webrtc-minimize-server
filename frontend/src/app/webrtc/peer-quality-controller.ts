import { OptimizationMode, QualitySettings, classifyLinkStats, stabilizeLinkClass } from "./media-optimization-policy";
import { ManagedPeer } from "./peer-connection-manager";

export interface PeerQualitySample {
  readonly availableOutgoingBitrate?: number;
  readonly roundTripTime?: number;
  readonly lossRatio?: number;
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
    mode: OptimizationMode,
    force: boolean,
  ): Promise<"available" | "degraded" | null> {
    const signature = `audio:${mode}`;
    if (!force && peer.appliedTiers.get(publicationId) === signature) return null;
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return "degraded";
    parameters.encodings[0].active = true;
    parameters.encodings[0].maxBitrate = mode === "data-saver" ? 20_000 : 32_000;
    try {
      await sender.setParameters(parameters);
      peer.appliedTiers.set(publicationId, signature);
      return "available";
    } catch {
      return "degraded";
    }
  }

  async applyVideo(
    peer: ManagedPeer,
    publicationId: string,
    sender: RTCRtpSender,
    quality: QualitySettings,
    force: boolean,
  ): Promise<"available" | "degraded" | null> {
    const signature = `${quality.tier}:${quality.maxBitrate}:${quality.maxFramerate}:${quality.scaleResolutionDownBy}`;
    if (!force && peer.appliedTiers.get(publicationId) === signature) return null;
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return "degraded";
    parameters.degradationPreference = quality.tier === "screen" ? "maintain-resolution" : "balanced";
    parameters.encodings[0].active = quality.active;
    parameters.encodings[0].maxBitrate = Math.max(1, quality.maxBitrate);
    parameters.encodings[0].maxFramerate = quality.maxFramerate;
    parameters.encodings[0].scaleResolutionDownBy = quality.scaleResolutionDownBy;
    try {
      await sender.setParameters(parameters);
      peer.appliedTiers.set(publicationId, signature);
      return "available";
    } catch {
      return "degraded";
    }
  }
}
