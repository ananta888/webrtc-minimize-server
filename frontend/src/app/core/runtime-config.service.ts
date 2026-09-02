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
    frameEnvelope: "codec-prefix-v1";
  }>;
  readonly mediaAgents: Readonly<{
    configured: boolean;
    selfService: boolean;
    targets: readonly Readonly<{
      id: string;
      platform: "linux" | "macos" | "windows";
      label: string;
    }>[];
    unsignedArtifacts: boolean;
    leaseMs: number;
    maxStandbys: number;
    minimumParticipants: number;
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
      || config.mediaE2ee.frameEnvelope !== "codec-prefix-v1"
      || typeof config.edgeRelayConfigured !== "boolean" || !config.mediaAgents
      || typeof config.mediaAgents.configured !== "boolean"
      || typeof config.mediaAgents.selfService !== "boolean"
      || !Array.isArray(config.mediaAgents.targets)
      || config.mediaAgents.targets.length > 5
      || config.mediaAgents.targets.some((target) => !target || typeof target !== "object"
        || !/^(?:linux|macos|windows)-(?:amd64|arm64)$/.test(target.id)
        || !new Set(["linux", "macos", "windows"]).has(target.platform)
        || typeof target.label !== "string" || target.label.length < 1 || target.label.length > 64)
      || typeof config.mediaAgents.unsignedArtifacts !== "boolean"
      || !Number.isSafeInteger(config.mediaAgents.leaseMs)
      || config.mediaAgents.leaseMs < 15_000 || config.mediaAgents.leaseMs > 120_000
      || !Number.isSafeInteger(config.mediaAgents.maxStandbys)
      || config.mediaAgents.maxStandbys < 0 || config.mediaAgents.maxStandbys > 2
      || !Number.isSafeInteger(config.mediaAgents.minimumParticipants)
      || config.mediaAgents.minimumParticipants < 3
      || config.mediaAgents.minimumParticipants > 20
      || !Number.isSafeInteger(config.mediaAgents.shardMinParticipants)
      || config.mediaAgents.shardMinParticipants < 3
      || config.mediaAgents.shardMinParticipants > 20) throw new Error("runtime_config_invalid");
    this.value.set(config);
    return config;
  }
}
