import { Injectable } from "@angular/core";

import { RuntimeConfigService } from "../core/runtime-config.service";
import {
  BroadcastBrowserPortError,
  BroadcastConsentDecision,
  BroadcastConsentPort,
  BroadcastProgramRef,
  BroadcastPublicationCapability,
  BroadcastPublicationPort,
  BroadcastPublicationRequest,
  BroadcastPublicationSession,
  BroadcastRoomSourceRef,
  BroadcastStatsPort,
  BroadcastStatsSample,
} from "./broadcast-ports";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { BroadcastOwnSourceCompositionService } from "./broadcast-own-source-composition.service";
import { Rfc9725WhipTransport } from "./whip-browser-transport";
import { whipRuntimeConfiguration } from "./whip-runtime";

@Injectable({ providedIn: "root" })
export class ExplicitBroadcastConsentService implements BroadcastConsentPort {
  async authorize(
    program: BroadcastProgramRef,
    sources: readonly BroadcastRoomSourceRef[],
    signal: AbortSignal,
  ): Promise<BroadcastConsentDecision> {
    signal.throwIfAborted();
    if (sources.length < 1 || sources.length > 4
      || sources.some((source) => !source.local || !source.active)
      || new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) {
      throw new BroadcastBrowserPortError("broadcast_own_source_consent_required");
    }
    return Object.freeze({
      decisionVersion: 1,
      programEpoch: program.programEpoch,
      sourceIds: Object.freeze(sources.map(({ sourceId }) => sourceId)),
      expiresAt: Date.now() + 45_000,
    });
  }
}

@Injectable({ providedIn: "root" })
export class BrowserWhipBroadcastRuntimeService implements BroadcastPublicationPort, BroadcastStatsPort {
  private activeTransport: Rfc9725WhipTransport | null = null;

  constructor(
    private readonly config: RuntimeConfigService,
    private readonly authorization: BroadcastControlPlaneService,
    private readonly media: BroadcastOwnSourceCompositionService,
  ) {}

  get capability(): BroadcastPublicationCapability {
    const whip = this.config.value()?.broadcast.whip;
    const available = whip?.enabled === true;
    return Object.freeze({
      capabilityVersion: 1,
      adapterId: "whip-browser",
      kind: "whip",
      available,
      ingestProtocols: Object.freeze(["whip" as const]),
      supportsAudio: true,
      supportsVideo: true,
      supportsSimulcast: available && whip.simulcast.enabled,
      ...(available ? {} : { reasonCode: "whip-not-configured" }),
    });
  }

  async start(
    request: BroadcastPublicationRequest,
    signal: AbortSignal,
  ): Promise<BroadcastPublicationSession> {
    const transport = this.transport();
    return transport.start(request, signal);
  }

  async stop(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void> {
    if (!this.activeTransport) return;
    await this.activeTransport.stop(session, signal);
  }

  subscribe(
    session: BroadcastPublicationSession,
    listener: (sample: BroadcastStatsSample) => void,
  ): () => void {
    const transport = this.activeTransport;
    if (!transport) throw new BroadcastBrowserPortError("whip-not-configured");
    let active = true;
    let sampling = false;
    const sample = async () => {
      if (!active || sampling) return;
      sampling = true;
      try {
        const value = await transport.sampleStats(session);
        if (active) listener(Object.freeze({
          sampledAt: value.sampledAt,
          outboundBitsPerSecond: value.measuredOutgoingBitrate || 0,
          inboundBitsPerSecond: 0,
          droppedFrames: 0,
        }));
      } catch {
        // The WHIP transport owns lifecycle degradation; stats must not create a second failure path.
      } finally {
        sampling = false;
      }
    };
    const handle = setInterval(() => { void sample(); }, 2_000);
    void sample();
    return () => {
      active = false;
      clearInterval(handle);
    };
  }

  private transport(): Rfc9725WhipTransport {
    if (this.activeTransport) return this.activeTransport;
    const config = this.config.value();
    if (!config?.broadcast.whip.enabled) throw new BroadcastBrowserPortError("whip-not-configured");
    this.activeTransport = new Rfc9725WhipTransport(whipRuntimeConfiguration(config), {
      authorization: this.authorization,
      media: this.media,
    });
    return this.activeTransport;
  }
}
