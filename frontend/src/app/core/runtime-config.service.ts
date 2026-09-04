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
  readonly broadcast: Readonly<{
    whip: Readonly<{
      configurationVersion: 1;
      compatibilityProfile: "rfc9725" | "mediamtx-1.20";
      enabled: boolean;
      endpointUrl: string;
      allowedRedirectOrigins: readonly string[];
      trickleIce: boolean;
      simulcast: Readonly<{
        enabled: boolean;
        sendEncodings: readonly RTCRtpEncodingParameters[];
      }>;
      codecPreferences: Readonly<{
        audio: readonly string[];
        video: readonly string[];
      }>;
      requestTimeoutMs: number;
      iceGatheringTimeoutMs: number;
      connectionTimeoutMs: number;
      maximumResponseBytes: number;
      maximumSdpBytes: number;
      maximumIceFragmentBytes: number;
      maximumCandidates: number;
      retryBudget: number;
    }>;
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

function validWhipSimulcast(value: RuntimeConfig["broadcast"]["whip"]["simulcast"]): boolean {
  if (!value || typeof value !== "object" || typeof value.enabled !== "boolean"
    || !Array.isArray(value.sendEncodings) || value.sendEncodings.length > 3
    || (!value.enabled && value.sendEncodings.length !== 0)
    || (value.enabled && value.sendEncodings.length < 2)) return false;
  const rids = new Set<string>();
  return value.sendEncodings.every((encoding) => {
    if (!encoding || typeof encoding !== "object"
      || Object.keys(encoding).some((field) => !new Set([
        "rid", "active", "maxBitrate", "maxFramerate", "scaleResolutionDownBy",
      ]).has(field))
      || typeof encoding.rid !== "string" || !/^[a-z0-9]{1,8}$/.test(encoding.rid)
      || rids.has(encoding.rid)
      || typeof encoding.active !== "boolean"
      || !Number.isSafeInteger(encoding.maxBitrate)
      || Number(encoding.maxBitrate) < 50_000 || Number(encoding.maxBitrate) > 20_000_000
      || !Number.isSafeInteger(encoding.maxFramerate)
      || Number(encoding.maxFramerate) < 1 || Number(encoding.maxFramerate) > 60
      || typeof encoding.scaleResolutionDownBy !== "number"
      || !Number.isFinite(encoding.scaleResolutionDownBy)
      || encoding.scaleResolutionDownBy < 1 || encoding.scaleResolutionDownBy > 16) return false;
    rids.add(encoding.rid);
    return true;
  });
}

export function validWhipRuntime(config: RuntimeConfig): boolean {
  const whip = config.broadcast?.whip;
  if (!whip || whip.configurationVersion !== 1
    || !new Set(["rfc9725", "mediamtx-1.20"]).has(whip.compatibilityProfile)
    || typeof whip.enabled !== "boolean"
    || typeof whip.endpointUrl !== "string" || typeof whip.trickleIce !== "boolean"
    || !Array.isArray(whip.allowedRedirectOrigins) || whip.allowedRedirectOrigins.length > 8
    || whip.allowedRedirectOrigins.some((origin) => typeof origin !== "string")
    || !validWhipSimulcast(whip.simulcast)
    || (whip.compatibilityProfile === "mediamtx-1.20" && whip.simulcast.enabled)
    || !Array.isArray(whip.codecPreferences?.audio) || !Array.isArray(whip.codecPreferences?.video)
    || whip.codecPreferences.audio.length > 8 || whip.codecPreferences.video.length > 8
    || [...whip.codecPreferences.audio, ...whip.codecPreferences.video].some(
      (codec) => typeof codec !== "string" || codec.length > 72,
    )
    || !Number.isSafeInteger(whip.requestTimeoutMs) || whip.requestTimeoutMs < 1_000 || whip.requestTimeoutMs > 30_000
    || !Number.isSafeInteger(whip.iceGatheringTimeoutMs) || whip.iceGatheringTimeoutMs < 1_000
    || whip.iceGatheringTimeoutMs > 30_000
    || !Number.isSafeInteger(whip.connectionTimeoutMs) || whip.connectionTimeoutMs < 1_000
    || whip.connectionTimeoutMs > 60_000
    || !Number.isSafeInteger(whip.maximumResponseBytes) || whip.maximumResponseBytes < 1_024
    || whip.maximumResponseBytes > 512 * 1_024
    || !Number.isSafeInteger(whip.maximumSdpBytes) || whip.maximumSdpBytes < 1_024
    || whip.maximumSdpBytes > 512 * 1_024
    || !Number.isSafeInteger(whip.maximumIceFragmentBytes) || whip.maximumIceFragmentBytes < 256
    || whip.maximumIceFragmentBytes > 64 * 1_024
    || !Number.isSafeInteger(whip.maximumCandidates) || whip.maximumCandidates < 1 || whip.maximumCandidates > 128
    || !Number.isSafeInteger(whip.retryBudget) || whip.retryBudget < 0 || whip.retryBudget > 2) return false;
  try {
    const redirectOriginsValid = whip.allowedRedirectOrigins.every((origin) => {
      const parsed = new URL(origin);
      return parsed.protocol === "https:" && parsed.origin === parsed.href.replace(/\/$/, "")
        && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    });
    const codecPreferencesValid = whip.codecPreferences.audio.every(
      (codec) => /^audio\/[A-Za-z0-9!#$&^_.+-]{1,64}$/.test(codec),
    ) && whip.codecPreferences.video.every(
      (codec) => /^video\/[A-Za-z0-9!#$&^_.+-]{1,64}$/.test(codec),
    );
    if (!redirectOriginsValid || !codecPreferencesValid) return false;
  } catch {
    return false;
  }
  if (!whip.enabled) return whip.endpointUrl === "";
  try {
    const endpoint = new URL(whip.endpointUrl);
    return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password
      && !endpoint.search && !endpoint.hash;
  } catch {
    return false;
  }
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
      || config.mediaAgents.shardMinParticipants > 20
      || !validWhipRuntime(config)) throw new Error("runtime_config_invalid");
    this.value.set(config);
    return config;
  }
}
