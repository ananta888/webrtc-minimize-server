export class BroadcastDeliveryProfileError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "BroadcastDeliveryProfileError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new BroadcastDeliveryProfileError(code, status); }

export const ORIGIN_LLHLS_PROFILE = Object.freeze({
  profileId: "origin-llhls-x86-dev-v1",
  delivery: "origin-llhls",
  runtimeVerified: true,
  maximumViewers: 20,
  maximumRequestsPerSecond: 200,
  maximumEgressBitsPerSecond: 100_000_000,
  maximumBlockingReloads: 20,
  cpuLimit: 1,
  memoryLimitMiB: 512,
  observedMemoryMiB: 47,
  observedCpuPercent: 2,
  observedP95RequestLatencyMs: 7,
  endToGlassLatencyVerified: false,
});

export const CDN_HLS_PROFILE = Object.freeze({
  profileId: "cdn-standard-hls-v1",
  delivery: "cdn-standard-hls",
  runtimeVerified: false,
  segmentCache: "public-immutable-by-program-epoch",
  manifestCache: "revalidate-short-ttl",
  privateDelivery: "uncacheable-authorized-proxy",
});

function validCdn(value) {
  const fields = new Set([
    "enabled", "runtimeVerified", "originAuthenticated", "hostAllowed", "pathAllowed",
    "shielding", "purgeReady", "cacheKeyVersion", "maximumViewers", "healthy",
  ]);
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size && Object.keys(value).every((field) => fields.has(field))
    && ["enabled", "runtimeVerified", "originAuthenticated", "hostAllowed", "pathAllowed", "shielding", "purgeReady", "healthy"]
      .every((field) => typeof value[field] === "boolean")
    && value.cacheKeyVersion === 1 && Number.isSafeInteger(value.maximumViewers)
    && value.maximumViewers >= 1 && value.maximumViewers <= 1_000_000;
}

export function selectBroadcastDeliveryProfile(input) {
  const fields = new Set(["visibility", "expectedViewers", "originHealthy", "currentProfileId", "cdn"]);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.size || Object.keys(input).some((field) => !fields.has(field))
    || !new Set(["private", "unlisted", "public"]).has(input.visibility)
    || !Number.isSafeInteger(input.expectedViewers) || input.expectedViewers < 1 || input.expectedViewers > 1_000_000
    || typeof input.originHealthy !== "boolean"
    || (input.currentProfileId !== null && !new Set([ORIGIN_LLHLS_PROFILE.profileId, CDN_HLS_PROFILE.profileId]).has(input.currentProfileId))
    || !validCdn(input.cdn)) fail("invalid_broadcast_delivery_profile_request");

  const originFits = input.originHealthy && input.expectedViewers <= ORIGIN_LLHLS_PROFILE.maximumViewers;
  const cdnReady = input.visibility === "public" && input.cdn.enabled && input.cdn.runtimeVerified
    && input.cdn.originAuthenticated && input.cdn.hostAllowed && input.cdn.pathAllowed
    && input.cdn.shielding && input.cdn.purgeReady && input.cdn.healthy
    && input.expectedViewers <= input.cdn.maximumViewers;
  const selected = originFits ? ORIGIN_LLHLS_PROFILE : cdnReady ? CDN_HLS_PROFILE : null;
  if (!selected) {
    fail(input.originHealthy || input.cdn.healthy
      ? "broadcast_delivery_capacity_exhausted" : "broadcast_delivery_unavailable", 503);
  }
  return Object.freeze({
    profile: selected,
    changed: input.currentProfileId !== null && input.currentProfileId !== selected.profileId,
    transition: input.currentProfileId !== null && input.currentProfileId !== selected.profileId
      ? "visible-short-restart" : "none",
    admittedViewers: selected.delivery === "origin-llhls"
      ? ORIGIN_LLHLS_PROFILE.maximumViewers : input.cdn.maximumViewers,
  });
}

export function createPublicCdnCachePolicy({ host, pathPrefix, programEpoch, originSecret }) {
  if (typeof host !== "string" || !/^[a-z0-9.-]{1,253}$/.test(host)
    || typeof pathPrefix !== "string" || !/^\/broadcast\/public\/res_[A-Za-z0-9_-]{16,64}\/$/.test(pathPrefix)
    || !Number.isSafeInteger(programEpoch) || programEpoch < 1
    || typeof originSecret !== "string" || originSecret.length < 32 || originSecret.length > 512
    || /[\u0000-\u001f\u007f]/.test(originSecret)) fail("invalid_public_cdn_policy");
  return Object.freeze({
    cacheKey: `${host}${pathPrefix}epoch-${programEpoch}/{object}`,
    allowedHost: host,
    allowedPathPrefix: pathPrefix,
    originAuthorization: "shared-secret-header",
    shieldingRequired: true,
    purgeKey: `epoch-${programEpoch}`,
    manifestCacheControl: "public, max-age=1, must-revalidate",
    segmentCacheControl: "public, max-age=31536000, immutable",
  });
}
