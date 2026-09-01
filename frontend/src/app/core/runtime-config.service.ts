import { Injectable, signal } from "@angular/core";

export type AuthMode = "disabled" | "optional" | "required";

export interface RuntimeConfig {
  readonly iceServers: readonly RTCIceServer[];
  readonly maxRoomParticipants: number;
  readonly pairParticipants: number;
  readonly turnConfigured: boolean;
  readonly edgeRelayConfigured: boolean;
  readonly mediaE2ee: Readonly<{
    mode: "disabled" | "preferred" | "required";
    cipherSuite: "AES_128_GCM_SHA256_128";
  }>;
  readonly mediaAgents: Readonly<{
    configured: boolean;
    leaseMs: number;
    maxStandbys: number;
    shardMinParticipants: number;
  }>;
  readonly optimization: Readonly<{
    activeSpeakerLimit: number;
    peerRelayEnabled: boolean;
    peerRelayMinParticipants: number;
    peerRelayMaxChildren: number;
    peerRelayMaxHops: number;
    routeLeaseMs: number;
    dataOverlayEnabled: boolean;
  }>;
  readonly pairWorkspaceEnabled: boolean;
  readonly auth: Readonly<{
    mode: AuthMode;
    issuer: string;
    clientId: string;
    audience: string;
  }>;
}
@Injectable({ providedIn: "root" })
export class RuntimeConfigService {
  readonly value = signal<RuntimeConfig | null>(null);

  async load(): Promise<RuntimeConfig> {
    const response = await fetch("/config", { credentials: "same-origin" });
    if (!response.ok) throw new Error("runtime_config_unavailable");
    const config = await response.json() as RuntimeConfig;
    if (!config.auth || !Array.isArray(config.iceServers) || !config.mediaE2ee
      || !new Set(["disabled", "preferred", "required"]).has(config.mediaE2ee.mode)
      || config.mediaE2ee.cipherSuite !== "AES_128_GCM_SHA256_128"
      || typeof config.edgeRelayConfigured !== "boolean" || !config.mediaAgents
      || typeof config.mediaAgents.configured !== "boolean"
      || !Number.isSafeInteger(config.mediaAgents.leaseMs)
      || config.mediaAgents.leaseMs < 15_000 || config.mediaAgents.leaseMs > 120_000
      || !Number.isSafeInteger(config.mediaAgents.maxStandbys)
      || config.mediaAgents.maxStandbys < 0 || config.mediaAgents.maxStandbys > 2
      || !Number.isSafeInteger(config.mediaAgents.shardMinParticipants)
      || config.mediaAgents.shardMinParticipants < 3
      || config.mediaAgents.shardMinParticipants > 20) throw new Error("runtime_config_invalid");
    this.value.set(config);
    return config;
  }
}
