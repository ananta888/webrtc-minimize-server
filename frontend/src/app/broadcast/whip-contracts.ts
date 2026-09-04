import {
  BroadcastBrowserPortError,
  BroadcastCompositionHandle,
  BroadcastProgramRef,
  BroadcastSourceKind,
} from "./broadcast-ports";

export type WhipAction = "whip:create" | "whip:update" | "whip:delete";
export type WhipSessionLifecycle = "connecting" | "connected" | "degraded" | "failed" | "stopped";

export interface WhipAuthorizationRequest {
  readonly requestVersion: 1;
  readonly program: BroadcastProgramRef;
  readonly action: WhipAction;
  readonly resourceUrl: string;
}

export interface WhipAuthorization {
  readonly authorizationVersion: 1;
  readonly accessToken: string;
  readonly expiresAt: number;
}

export interface WhipAuthorizationPort {
  authorize(request: WhipAuthorizationRequest, signal: AbortSignal): Promise<WhipAuthorization>;
}

export type WhipSyntheticSourceKind = "silence" | "slate" | "program-audio" | "program-video";
export type WhipSourceKind = BroadcastSourceKind | WhipSyntheticSourceKind;

export interface WhipAudioEncodingPolicy {
  readonly policyVersion: 1;
  readonly opusBitsPerSecond: number;
  readonly channelCount: 1 | 2;
  readonly dtx: boolean;
  readonly fec: boolean;
  readonly priority: RTCPriorityType;
  readonly contentHint: "speech" | "music";
}

export interface WhipMediaTrackDescriptor {
  readonly sourceId: string;
  readonly sourceKind: WhipSourceKind;
  readonly envelope: "clear-program-v1";
  readonly track: MediaStreamTrack;
  readonly audioEncoding?: WhipAudioEncodingPolicy;
}

export interface WhipResolvedMedia {
  readonly stream: MediaStream;
  readonly tracks: readonly WhipMediaTrackDescriptor[];
}

export interface WhipMediaStreamPort {
  resolve(composition: BroadcastCompositionHandle, signal: AbortSignal): Promise<WhipResolvedMedia>;
}

export interface WhipCodecPreferences {
  readonly audio: readonly string[];
  readonly video: readonly string[];
}

export interface WhipSimulcastConfiguration {
  readonly enabled: boolean;
  readonly sendEncodings: readonly RTCRtpEncodingParameters[];
}

export interface WhipRuntimeConfiguration {
  readonly configurationVersion: 1;
  readonly compatibilityProfile: "rfc9725" | "mediamtx-1.20";
  readonly endpointUrl: string;
  readonly allowedRedirectOrigins: readonly string[];
  readonly iceServers: readonly RTCIceServer[];
  readonly codecPreferences: WhipCodecPreferences;
  readonly simulcast: WhipSimulcastConfiguration;
  readonly trickleIce: boolean;
  readonly requestTimeoutMs: number;
  readonly iceGatheringTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly maximumResponseBytes: number;
  readonly maximumSdpBytes: number;
  readonly maximumIceFragmentBytes: number;
  readonly maximumCandidates: number;
  readonly retryBudget: number;
}

export interface NormalizedWhipRuntimeConfiguration extends WhipRuntimeConfiguration {
  readonly endpointUrl: string;
  readonly allowedRedirectOrigins: readonly string[];
  readonly iceServers: readonly RTCIceServer[];
  readonly codecPreferences: WhipCodecPreferences;
  readonly simulcast: WhipSimulcastConfiguration;
}

const TOKEN_CONTROL = /[\u0000-\u001f\u007f]/;
const MIME_TYPE = /^(?:audio|video)\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const SOURCE_KINDS = new Set<WhipSourceKind>([
  "microphone", "camera", "screen", "screen-audio", "silence", "slate", "program-audio", "program-video",
]);

function fail(code: string): never {
  throw new BroadcastBrowserPortError(code);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("invalid_whip_runtime_configuration");
  }
  return Number(value);
}

function normalizeHttpsUrl(value: unknown, allowLoopbackHttp = false): URL {
  if (typeof value !== "string" || value.length > 2_048) fail("invalid_whip_runtime_configuration");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_whip_runtime_configuration");
  }
  const loopback = allowLoopbackHttp && parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !loopback)
    || parsed.username || parsed.password || parsed.hash || parsed.search) {
    fail("invalid_whip_runtime_configuration");
  }
  return parsed;
}

function normalizeIceServers(value: unknown): readonly RTCIceServer[] {
  if (!Array.isArray(value) || value.length > 8) fail("invalid_whip_runtime_configuration");
  return Object.freeze(value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      fail("invalid_whip_runtime_configuration");
    }
    const entry = candidate as Record<string, unknown>;
    const allowed = new Set(["urls", "username", "credential"]);
    if (Object.keys(entry).some((field) => !allowed.has(field))) fail("invalid_whip_runtime_configuration");
    const urls = typeof entry["urls"] === "string"
      ? [entry["urls"]]
      : Array.isArray(entry["urls"]) && entry["urls"].every((url) => typeof url === "string")
        ? entry["urls"]
        : null;
    if (!urls || urls.length < 1 || urls.length > 8
      || urls.some((url) => url.length > 1_024 || !/^(?:stun|stuns|turn|turns):[^\s]+$/i.test(url))) {
      fail("invalid_whip_runtime_configuration");
    }
    const username = entry["username"];
    const credential = entry["credential"];
    if ((username !== undefined && (typeof username !== "string" || username.length > 512 || TOKEN_CONTROL.test(username)))
      || (credential !== undefined && (typeof credential !== "string" || credential.length > 512
        || TOKEN_CONTROL.test(credential)))) {
      fail("invalid_whip_runtime_configuration");
    }
    return Object.freeze({
      urls: Object.freeze([...urls]) as unknown as string[],
      ...(username === undefined ? {} : { username }),
      ...(credential === undefined ? {} : { credential }),
    });
  }));
}

function normalizeCodecs(value: unknown, kind: "audio" | "video"): readonly string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some((codec) => (
    typeof codec !== "string" || !MIME_TYPE.test(codec) || !codec.toLowerCase().startsWith(`${kind}/`)
  ))) fail("invalid_whip_runtime_configuration");
  const normalized = value.map((codec) => codec.toLowerCase());
  if (new Set(normalized).size !== normalized.length) fail("invalid_whip_runtime_configuration");
  return Object.freeze(normalized);
}

function normalizeSimulcast(value: unknown): WhipSimulcastConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_whip_runtime_configuration");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((field) => !new Set(["enabled", "sendEncodings"]).has(field))
    || typeof candidate["enabled"] !== "boolean" || !Array.isArray(candidate["sendEncodings"])
    || candidate["sendEncodings"].length > 3) fail("invalid_whip_runtime_configuration");
  if (!candidate["enabled"] && candidate["sendEncodings"].length !== 0) {
    fail("invalid_whip_runtime_configuration");
  }
  if (candidate["enabled"] && candidate["sendEncodings"].length < 2) {
    fail("invalid_whip_runtime_configuration");
  }
  const ridPattern = /^[a-z0-9]{1,8}$/;
  const rids = new Set<string>();
  const sendEncodings = candidate["sendEncodings"].map((encoding) => {
    if (!encoding || typeof encoding !== "object" || Array.isArray(encoding)) {
      fail("invalid_whip_runtime_configuration");
    }
    const record = encoding as Record<string, unknown>;
    const allowed = new Set(["rid", "active", "maxBitrate", "maxFramerate", "scaleResolutionDownBy"]);
    if (Object.keys(record).some((field) => !allowed.has(field))
      || typeof record["rid"] !== "string" || !ridPattern.test(record["rid"]) || rids.has(record["rid"])
      || (record["active"] !== undefined && typeof record["active"] !== "boolean")
      || (record["maxBitrate"] !== undefined
        && boundedInteger(record["maxBitrate"], 50_000, 20_000_000) !== record["maxBitrate"])
      || (record["maxFramerate"] !== undefined
        && boundedInteger(record["maxFramerate"], 1, 60) !== record["maxFramerate"])
      || (record["scaleResolutionDownBy"] !== undefined
        && (typeof record["scaleResolutionDownBy"] !== "number"
          || !Number.isFinite(record["scaleResolutionDownBy"])
          || record["scaleResolutionDownBy"] < 1 || record["scaleResolutionDownBy"] > 16))) {
      fail("invalid_whip_runtime_configuration");
    }
    rids.add(record["rid"]);
    return Object.freeze({ ...record }) as RTCRtpEncodingParameters;
  });
  return Object.freeze({ enabled: candidate["enabled"], sendEncodings: Object.freeze(sendEncodings) });
}

export function normalizeWhipRuntimeConfiguration(
  value: WhipRuntimeConfiguration,
  options: Readonly<{ allowLoopbackHttp?: boolean }> = {},
): NormalizedWhipRuntimeConfiguration {
  if (!value || typeof value !== "object" || value.configurationVersion !== 1
    || (value.compatibilityProfile !== "rfc9725" && value.compatibilityProfile !== "mediamtx-1.20")) {
    fail("invalid_whip_runtime_configuration");
  }
  const endpoint = normalizeHttpsUrl(value.endpointUrl, options.allowLoopbackHttp === true);
  if (!Array.isArray(value.allowedRedirectOrigins) || value.allowedRedirectOrigins.length > 8) {
    fail("invalid_whip_runtime_configuration");
  }
  const origins = value.allowedRedirectOrigins.map((origin) => {
    const parsed = normalizeHttpsUrl(origin, options.allowLoopbackHttp === true);
    if (parsed.pathname !== "/") fail("invalid_whip_runtime_configuration");
    return parsed.origin;
  });
  origins.unshift(endpoint.origin);
  const allowedRedirectOrigins = Object.freeze([...new Set(origins)]);
  const audio = normalizeCodecs(value.codecPreferences?.audio, "audio");
  const video = normalizeCodecs(value.codecPreferences?.video, "video");
  return Object.freeze({
    configurationVersion: 1,
    compatibilityProfile: value.compatibilityProfile,
    endpointUrl: endpoint.href,
    allowedRedirectOrigins,
    iceServers: normalizeIceServers(value.iceServers),
    codecPreferences: Object.freeze({ audio, video }),
    simulcast: normalizeSimulcast(value.simulcast),
    trickleIce: value.trickleIce === true,
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs, 1_000, 30_000),
    iceGatheringTimeoutMs: boundedInteger(value.iceGatheringTimeoutMs, 1_000, 30_000),
    connectionTimeoutMs: boundedInteger(value.connectionTimeoutMs, 1_000, 60_000),
    maximumResponseBytes: boundedInteger(value.maximumResponseBytes, 1_024, 512 * 1_024),
    maximumSdpBytes: boundedInteger(value.maximumSdpBytes, 1_024, 512 * 1_024),
    maximumIceFragmentBytes: boundedInteger(value.maximumIceFragmentBytes, 256, 64 * 1_024),
    maximumCandidates: boundedInteger(value.maximumCandidates, 1, 128),
    retryBudget: boundedInteger(value.retryBudget, 0, 2),
  });
}

export function normalizeWhipAuthorization(value: unknown, now = Date.now()): WhipAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_whip_authorization");
  const authorization = value as Record<string, unknown>;
  if (Object.keys(authorization).length !== 3
    || Object.keys(authorization).some((field) => !new Set([
      "authorizationVersion", "accessToken", "expiresAt",
    ]).has(field))
    || authorization["authorizationVersion"] !== 1
    || typeof authorization["accessToken"] !== "string"
    || authorization["accessToken"].length < 16 || authorization["accessToken"].length > 8 * 1024
    || TOKEN_CONTROL.test(authorization["accessToken"])
    || !Number.isSafeInteger(authorization["expiresAt"])
    || Number(authorization["expiresAt"]) <= now + 1_000
    || Number(authorization["expiresAt"]) > now + 5 * 60_000) {
    fail("invalid_whip_authorization");
  }
  return Object.freeze({
    authorizationVersion: 1,
    accessToken: authorization["accessToken"],
    expiresAt: Number(authorization["expiresAt"]),
  });
}

export function normalizeWhipResolvedMedia(value: unknown): WhipResolvedMedia {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_whip_media_stream");
  const media = value as Record<string, unknown>;
  if (Object.keys(media).length !== 2
    || Object.keys(media).some((field) => !new Set(["stream", "tracks"]).has(field))
    || !media["stream"] || typeof media["stream"] !== "object"
    || typeof (media["stream"] as MediaStream).getTracks !== "function"
    || !Array.isArray(media["tracks"]) || media["tracks"].length < 1 || media["tracks"].length > 2) {
    fail("invalid_whip_media_stream");
  }
  const stream = media["stream"] as MediaStream;
  const streamTracks = stream.getTracks();
  const sourceIds = new Set<string>();
  const kinds = new Set<string>();
  const tracks = media["tracks"].map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_whip_media_stream");
    const descriptor = value as Record<string, unknown>;
    if (Object.keys(descriptor).length < 4 || Object.keys(descriptor).length > 5
      || Object.keys(descriptor).some((field) => !new Set([
        "sourceId", "sourceKind", "envelope", "track", "audioEncoding",
      ]).has(field))
      || typeof descriptor["sourceId"] !== "string" || !SOURCE_ID.test(descriptor["sourceId"])
      || sourceIds.has(descriptor["sourceId"])
      || typeof descriptor["sourceKind"] !== "string"
      || !SOURCE_KINDS.has(descriptor["sourceKind"] as WhipSourceKind)
      || descriptor["envelope"] !== "clear-program-v1"
      || !descriptor["track"] || typeof descriptor["track"] !== "object") {
      fail("invalid_whip_media_stream");
    }
    const track = descriptor["track"] as MediaStreamTrack;
    const expectedKind = new Set(["microphone", "screen-audio", "silence", "program-audio"]).has(descriptor["sourceKind"])
      ? "audio"
      : "video";
    if (track.kind !== expectedKind || track.readyState !== "live"
      || typeof track.addEventListener !== "function" || typeof track.removeEventListener !== "function"
      || kinds.has(track.kind)
      || !streamTracks.includes(track)) fail("invalid_whip_media_stream");
    const audioEncoding = descriptor["audioEncoding"] as Record<string, unknown> | undefined;
    if ((descriptor["sourceKind"] === "program-audio") !== Boolean(audioEncoding)
      || (audioEncoding && (Object.keys(audioEncoding).length !== 7
        || Object.keys(audioEncoding).some((field) => !new Set([
          "policyVersion", "opusBitsPerSecond", "channelCount", "dtx", "fec", "priority", "contentHint",
        ]).has(field))
        || audioEncoding["policyVersion"] !== 1
        || !Number.isSafeInteger(audioEncoding["opusBitsPerSecond"])
        || Number(audioEncoding["opusBitsPerSecond"]) < 20_000
        || Number(audioEncoding["opusBitsPerSecond"]) > 510_000
        || (audioEncoding["channelCount"] !== 1 && audioEncoding["channelCount"] !== 2)
        || typeof audioEncoding["dtx"] !== "boolean" || typeof audioEncoding["fec"] !== "boolean"
        || !new Set(["very-low", "low", "medium", "high"]).has(String(audioEncoding["priority"]))
        || !new Set(["speech", "music"]).has(String(audioEncoding["contentHint"]))))) {
      fail("invalid_whip_media_stream");
    }
    sourceIds.add(descriptor["sourceId"]);
    kinds.add(track.kind);
    return Object.freeze({
      sourceId: descriptor["sourceId"],
      sourceKind: descriptor["sourceKind"] as WhipSourceKind,
      envelope: "clear-program-v1" as const,
      track,
      ...(audioEncoding ? { audioEncoding: Object.freeze({ ...audioEncoding }) as unknown as WhipAudioEncodingPolicy } : {}),
    });
  });
  if (streamTracks.length !== tracks.length || streamTracks.some((track) => !tracks.some(
    (descriptor) => descriptor.track === track,
  ))) fail("invalid_whip_media_stream");
  return Object.freeze({ stream, tracks: Object.freeze(tracks) });
}

export function assertWhipResourceUrl(
  value: string,
  configuration: NormalizedWhipRuntimeConfiguration,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value, configuration.endpointUrl);
  } catch {
    fail("invalid_whip_resource_url");
  }
  const endpoint = new URL(configuration.endpointUrl);
  const loopbackHttp = endpoint.protocol === "http:" && parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !loopbackHttp)
    || parsed.username || parsed.password || parsed.hash || parsed.search
    || !configuration.allowedRedirectOrigins.includes(parsed.origin)) {
    fail("invalid_whip_resource_url");
  }
  return parsed;
}
