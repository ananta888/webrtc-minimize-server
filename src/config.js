import {
  DEFAULT_ROOM_PARTICIPANTS,
  MAX_ROOM_PARTICIPANTS,
  MIN_ROOM_PARTICIPANTS,
} from "./room-limits.js";

const DEFAULTS = Object.freeze({
  host: "0.0.0.0",
  port: 8080,
  publicOrigin: "",
  stunUrls: ["stun:stun.l.google.com:19302"],
  turnServers: [],
  maxRoomParticipants: DEFAULT_ROOM_PARTICIPANTS,
  roomIdleTtlMs: 60 * 60 * 1000,
  signalRateLimit: 300,
  authMode: "disabled",
  oidcIssuer: "",
  oidcAudience: "webrtc-room-server",
  oidcClientId: "webrtc-browser",
  oidcJwksUrl: "",
  oidcJwksCacheMs: 5 * 60 * 1000,
  sessionTicketTtlMs: 30_000,
  deviceProofMaxAgeMs: 60_000,
  turnUrls: [],
  turnSharedSecret: "",
  turnRealm: "webrtc.local",
  turnCredentialTtlMs: 10 * 60 * 1000,
  edgeTurnServers: [],
  peerEdgeFallbackMs: 4_000,
  infrastructureTurnFallbackMs: 9_000,
  mediaE2eeMode: "required",
  peerMediaRelayEnabled: true,
  peerMediaRelayMinParticipants: 3,
  peerMediaRelayMaxChildren: 3,
  peerMediaRelayMaxHops: 3,
  peerRouteLeaseMs: 60_000,
  peerRouteRenewMs: 25_000,
  peerRelayHealthWindowMs: 30_000,
  peerRelayHealthCooldownMs: 60_000,
  peerDataOverlayEnabled: true,
  pairWorkspaceEnabled: true,
  pairWorkspaceDb: "data/pair-workspaces.sqlite",
  activeSpeakerLimit: 5,
  mediaAgents: [],
  mediaAgentLeaseMs: 30_000,
  mediaAgentRenewMs: 10_000,
  mediaAgentMaxStandbys: 2,
  mediaAgentMinParticipants: 3,
  mediaAgentShardMinParticipants: 6,
  mediaAgentTakeoverTtlMs: 20_000,
  mediaAgentRateLimit: 2_000,
  mediaAgentSelfServiceEnabled: false,
  mediaAgentRegistrationDb: "data/media-agent-registrations.sqlite",
  mediaAgentArtifactDir: "media-agent-downloads",
  mediaAgentEnrollmentTtlMs: 10 * 60 * 1000,
  mediaAgentMaxPerPrincipal: 3,
  mediaAgentEnrollmentRateLimit: 5,
  broadcastWhipEndpoint: "",
  broadcastWhipProfile: "rfc9725",
  broadcastWhipRedirectOrigins: [],
  broadcastWhipTrickleIce: true,
  broadcastWhipAudioCodecs: ["audio/opus"],
  broadcastWhipVideoCodecs: ["video/vp8", "video/h264"],
  broadcastWhipRequestTimeoutMs: 8_000,
  broadcastWhipIceGatheringTimeoutMs: 10_000,
  broadcastWhipConnectionTimeoutMs: 20_000,
  broadcastWhipRetryBudget: 1,
});

const AUTH_MODES = new Set(["disabled", "optional", "required"]);
const MEDIA_E2EE_MODES = new Set(["disabled", "preferred", "required"]);
const OIDC_ALGORITHMS = Object.freeze(["RS256", "ES256", "RS384", "RS512"]);
const EDGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PRINCIPAL_PATTERN = /^https?:\/\/[^\s|]+\|[^\s|]{1,255}$/;

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseTurnServers(raw) {
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`TURN_SERVERS_JSON must contain valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value)) throw new Error("TURN_SERVERS_JSON must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`TURN_SERVERS_JSON[${index}] must be an object`);
    }
    const urls = typeof entry.urls === "string"
      ? entry.urls
      : Array.isArray(entry.urls) && entry.urls.every((url) => typeof url === "string")
        ? entry.urls
        : null;
    if (!urls) throw new Error(`TURN_SERVERS_JSON[${index}].urls is required`);
    return {
      urls,
      ...(typeof entry.username === "string" ? { username: entry.username } : {}),
      ...(typeof entry.credential === "string" ? { credential: entry.credential } : {}),
    };
  });
}

function parseTurnUrls(value, name) {
  const urls = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((url) => typeof url === "string")
      ? value
      : null;
  if (!urls || urls.length < 1 || urls.length > 8
    || urls.some((url) => !/^turns?:[^\s]+$/i.test(url))) {
    throw new Error(`${name} must contain 1-8 turn: or turns: URLs`);
  }
  return [...new Set(urls)];
}

function parseEdgeTurnServers(raw) {
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`EDGE_TURN_SERVERS_JSON must contain valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("EDGE_TURN_SERVERS_JSON must be an array with at most 8 entries");
  }
  const ids = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !new Set(["id", "urls", "sharedSecret", "realm"]).has(key))) {
      throw new Error(`EDGE_TURN_SERVERS_JSON[${index}] contains an invalid entry or field`);
    }
    const id = String(entry.id || "");
    if (!EDGE_ID_PATTERN.test(id) || ids.has(id)) {
      throw new Error(`EDGE_TURN_SERVERS_JSON[${index}].id must be unique lowercase letters, digits or dashes`);
    }
    ids.add(id);
    const sharedSecret = String(entry.sharedSecret || "");
    if (sharedSecret.length < 32 || sharedSecret.length > 512 || /[\u0000-\u001f\u007f]/.test(sharedSecret)) {
      throw new Error(`EDGE_TURN_SERVERS_JSON[${index}].sharedSecret must contain 32-512 printable characters`);
    }
    const realm = String(entry.realm || "");
    if (!realm || realm.length > 253 || /[\u0000-\u0020\u007f]/.test(realm)) {
      throw new Error(`EDGE_TURN_SERVERS_JSON[${index}].realm is invalid`);
    }
    return Object.freeze({
      id,
      urls: Object.freeze(parseTurnUrls(entry.urls, `EDGE_TURN_SERVERS_JSON[${index}].urls`)),
      sharedSecret,
      realm,
    });
  });
}

function parseMediaAgents(raw) {
  if (!raw) return [];
  let value;
  try { value = JSON.parse(raw); } catch (error) {
    throw new Error(`MEDIA_EDGE_AGENTS_JSON must contain valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("MEDIA_EDGE_AGENTS_JSON must be an array with at most 32 entries");
  }
  const ids = new Set();
  return value.map((entry, index) => {
    const fields = new Set(["id", "ownerPrincipal", "sharedSecret"]);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).length !== fields.size || Object.keys(entry).some((key) => !fields.has(key))) {
      throw new Error(`MEDIA_EDGE_AGENTS_JSON[${index}] must contain exactly id, ownerPrincipal and sharedSecret`);
    }
    const id = String(entry.id || "");
    const ownerPrincipal = String(entry.ownerPrincipal || "");
    const sharedSecret = String(entry.sharedSecret || "");
    if (!EDGE_ID_PATTERN.test(id) || ids.has(id)) {
      throw new Error(`MEDIA_EDGE_AGENTS_JSON[${index}].id must be unique lowercase letters, digits or dashes`);
    }
    if (!PRINCIPAL_PATTERN.test(ownerPrincipal)) {
      throw new Error(`MEDIA_EDGE_AGENTS_JSON[${index}].ownerPrincipal must be an exact issuer|subject principal`);
    }
    if (sharedSecret.length < 32 || sharedSecret.length > 512 || /[\u0000-\u001f\u007f]/.test(sharedSecret)) {
      throw new Error(`MEDIA_EDGE_AGENTS_JSON[${index}].sharedSecret must contain 32-512 printable characters`);
    }
    ids.add(id);
    return Object.freeze({ id, ownerPrincipal, sharedSecret });
  });
}

function commaSeparated(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function httpUrl(value, name) {
  if (!value) return "";
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return parsed.href.replace(/\/$/, "");
}

function httpOrigin(value, name) {
  const normalized = httpUrl(value, name);
  if (!normalized) return "";
  const parsed = new URL(normalized);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) origin without a path, credentials, query or fragment`);
  }
  return parsed.origin;
}

function httpsWhipEndpoint(value) {
  const normalized = httpUrl(value, "BROADCAST_WHIP_ENDPOINT");
  if (!normalized) return "";
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BROADCAST_WHIP_ENDPOINT must be an HTTPS URL without credentials, query or fragment");
  }
  return parsed.href.replace(/\/$/, "");
}

function httpsOrigins(value) {
  const origins = commaSeparated(value);
  if (origins.length > 8) throw new Error("BROADCAST_WHIP_REDIRECT_ORIGINS supports at most 8 origins");
  return [...new Set(origins.map((origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== parsed.href.replace(/\/$/, "")
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("BROADCAST_WHIP_REDIRECT_ORIGINS entries must be HTTPS origins");
    }
    return parsed.origin;
  }))];
}

function mediaTypes(value, fallback, kind, name) {
  const items = commaSeparated(value === undefined ? fallback.join(",") : value)
    .map((item) => item.toLowerCase());
  if (items.length > 8 || new Set(items).size !== items.length
    || items.some((item) => !new RegExp(`^${kind}/[A-Za-z0-9!#$&^_.+-]{1,64}$`, "i").test(item))) {
    throw new Error(`${name} must contain up to 8 unique ${kind} MIME types`);
  }
  return items;
}

function keycloakRealm(value) {
  const normalized = String(value || "").trim();
  if (normalized && !/^[A-Za-z0-9._-]{1,128}$/.test(normalized)) {
    throw new Error("KEYCLOAK_REALM must contain only letters, numbers, dot, underscore or hyphen");
  }
  return normalized;
}

export function loadConfig(env = process.env) {
  const publicOrigin = String(env.PUBLIC_ORIGIN || DEFAULTS.publicOrigin).replace(/\/$/, "");
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.pathname !== "/") {
      throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path");
    }
  }
  const authMode = String(env.AUTH_MODE || DEFAULTS.authMode).toLowerCase();
  if (!AUTH_MODES.has(authMode)) throw new Error("AUTH_MODE must be disabled, optional or required");
  const configuredKeycloakOrigin = httpOrigin(env.KEYCLOAK_ORIGIN, "KEYCLOAK_ORIGIN");
  const configuredKeycloakRealm = keycloakRealm(env.KEYCLOAK_REALM);
  if (Boolean(configuredKeycloakOrigin) !== Boolean(configuredKeycloakRealm)) {
    throw new Error("KEYCLOAK_ORIGIN and KEYCLOAK_REALM must be configured together");
  }
  const derivedIssuer = configuredKeycloakOrigin
    ? `${configuredKeycloakOrigin}/realms/${configuredKeycloakRealm}`
    : "";
  const oidcIssuer = httpUrl(env.OIDC_ISSUER || derivedIssuer || DEFAULTS.oidcIssuer, "OIDC_ISSUER");
  const oidcAudience = String(env.OIDC_AUDIENCE || DEFAULTS.oidcAudience).trim();
  const oidcClientId = String(env.OIDC_CLIENT_ID || DEFAULTS.oidcClientId).trim();
  if (authMode !== "disabled" && (!oidcIssuer || !oidcAudience || !oidcClientId)) {
    throw new Error("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_CLIENT_ID are required when authentication is enabled");
  }
  const oidcJwksUrl = httpUrl(
    env.OIDC_JWKS_URL || (oidcIssuer ? `${oidcIssuer}/protocol/openid-connect/certs` : ""),
    "OIDC_JWKS_URL",
  );
  const turnUrls = commaSeparated(env.TURN_URLS || DEFAULTS.turnUrls.join(","));
  if (turnUrls.some((url) => !/^turns?:/i.test(url))) {
    throw new Error("TURN_URLS entries must use turn: or turns:");
  }
  const turnSharedSecret = String(env.TURN_SHARED_SECRET || DEFAULTS.turnSharedSecret);
  if ((turnUrls.length > 0) !== Boolean(turnSharedSecret)) {
    throw new Error("TURN_URLS and TURN_SHARED_SECRET must be configured together");
  }
  const edgeTurnServers = parseEdgeTurnServers(env.EDGE_TURN_SERVERS_JSON);
  const peerEdgeFallbackMs = boundedInteger(env.PEER_EDGE_FALLBACK_MS, DEFAULTS.peerEdgeFallbackMs, {
    minimum: 1_000, maximum: 30_000, name: "PEER_EDGE_FALLBACK_MS",
  });
  const infrastructureTurnFallbackMs = boundedInteger(
    env.INFRASTRUCTURE_TURN_FALLBACK_MS,
    DEFAULTS.infrastructureTurnFallbackMs,
    { minimum: 2_000, maximum: 60_000, name: "INFRASTRUCTURE_TURN_FALLBACK_MS" },
  );
  if (infrastructureTurnFallbackMs <= peerEdgeFallbackMs) {
    throw new Error("INFRASTRUCTURE_TURN_FALLBACK_MS must be longer than PEER_EDGE_FALLBACK_MS");
  }
  const mediaE2eeMode = String(env.MEDIA_E2EE_MODE || DEFAULTS.mediaE2eeMode).toLowerCase();
  if (!MEDIA_E2EE_MODES.has(mediaE2eeMode)) {
    throw new Error("MEDIA_E2EE_MODE must be disabled, preferred or required");
  }
  const peerDataOverlayEnabled = booleanValue(
    env.PEER_DATA_OVERLAY_ENABLED,
    DEFAULTS.peerDataOverlayEnabled,
    "PEER_DATA_OVERLAY_ENABLED",
  );
  if (mediaE2eeMode === "required" && !peerDataOverlayEnabled) {
    throw new Error("MEDIA_E2EE_MODE=required requires PEER_DATA_OVERLAY_ENABLED=true for key delivery");
  }
  const mediaAgents = parseMediaAgents(env.MEDIA_EDGE_AGENTS_JSON);
  const mediaAgentLeaseMs = boundedInteger(env.MEDIA_AGENT_LEASE_MS, DEFAULTS.mediaAgentLeaseMs, {
    minimum: 15_000, maximum: 120_000, name: "MEDIA_AGENT_LEASE_MS",
  });
  const mediaAgentRenewMs = boundedInteger(env.MEDIA_AGENT_RENEW_MS, DEFAULTS.mediaAgentRenewMs, {
    minimum: 5_000, maximum: 60_000, name: "MEDIA_AGENT_RENEW_MS",
  });
  if (mediaAgentRenewMs >= mediaAgentLeaseMs) {
    throw new Error("MEDIA_AGENT_RENEW_MS must be shorter than MEDIA_AGENT_LEASE_MS");
  }
  const mediaAgentSelfServiceEnabled = booleanValue(
    env.MEDIA_AGENT_SELF_SERVICE_ENABLED,
    DEFAULTS.mediaAgentSelfServiceEnabled,
    "MEDIA_AGENT_SELF_SERVICE_ENABLED",
  );
  if (mediaAgentSelfServiceEnabled && authMode === "disabled") {
    throw new Error("MEDIA_AGENT_SELF_SERVICE_ENABLED requires OIDC authentication");
  }
  if (mediaAgentSelfServiceEnabled && (!publicOrigin || new URL(publicOrigin).protocol !== "https:")) {
    throw new Error("MEDIA_AGENT_SELF_SERVICE_ENABLED requires an HTTPS PUBLIC_ORIGIN");
  }
  const mediaAgentRegistrationDb = String(
    env.MEDIA_AGENT_REGISTRATION_DB || DEFAULTS.mediaAgentRegistrationDb,
  ).trim();
  const mediaAgentArtifactDir = String(
    env.MEDIA_AGENT_ARTIFACT_DIR || DEFAULTS.mediaAgentArtifactDir,
  ).trim();
  if (mediaAgentSelfServiceEnabled && (!mediaAgentRegistrationDb || !mediaAgentArtifactDir)) {
    throw new Error("media-agent self service requires registration DB and artifact directory paths");
  }
  const broadcastWhipEndpoint = httpsWhipEndpoint(
    env.BROADCAST_WHIP_ENDPOINT || DEFAULTS.broadcastWhipEndpoint,
  );
  const broadcastWhipProfile = String(
    env.BROADCAST_WHIP_PROFILE || DEFAULTS.broadcastWhipProfile,
  ).toLowerCase();
  if (!new Set(["rfc9725", "mediamtx-1.20"]).has(broadcastWhipProfile)) {
    throw new Error("BROADCAST_WHIP_PROFILE must be rfc9725 or mediamtx-1.20");
  }
  const broadcastWhipRedirectOrigins = httpsOrigins(
    env.BROADCAST_WHIP_REDIRECT_ORIGINS || DEFAULTS.broadcastWhipRedirectOrigins.join(","),
  );
  const broadcastWhipTrickleIce = booleanValue(
    env.BROADCAST_WHIP_TRICKLE_ICE,
    DEFAULTS.broadcastWhipTrickleIce,
    "BROADCAST_WHIP_TRICKLE_ICE",
  );
  const peerRouteLeaseMs = boundedInteger(env.PEER_ROUTE_LEASE_MS, DEFAULTS.peerRouteLeaseMs, {
    minimum: 30_000, maximum: 300_000, name: "PEER_ROUTE_LEASE_MS",
  });
  const peerRouteRenewMs = boundedInteger(env.PEER_ROUTE_RENEW_MS, DEFAULTS.peerRouteRenewMs, {
    minimum: 5_000, maximum: 120_000, name: "PEER_ROUTE_RENEW_MS",
  });
  if (peerRouteRenewMs >= peerRouteLeaseMs) {
    throw new Error("PEER_ROUTE_RENEW_MS must be shorter than PEER_ROUTE_LEASE_MS");
  }
  return Object.freeze({
    host: env.HOST || DEFAULTS.host,
    port: boundedInteger(env.PORT, DEFAULTS.port, {
      minimum: 0, maximum: 65_535, name: "PORT",
    }),
    publicOrigin,
    stunUrls: String(env.STUN_URLS === undefined ? DEFAULTS.stunUrls.join(",") : env.STUN_URLS)
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    turnServers: parseTurnServers(env.TURN_SERVERS_JSON),
    maxRoomParticipants: boundedInteger(
      env.MAX_ROOM_PARTICIPANTS,
      DEFAULTS.maxRoomParticipants,
      {
        minimum: MIN_ROOM_PARTICIPANTS,
        maximum: MAX_ROOM_PARTICIPANTS,
        name: "MAX_ROOM_PARTICIPANTS",
      },
    ),
    roomIdleTtlMs: boundedInteger(env.ROOM_IDLE_TTL_MS, DEFAULTS.roomIdleTtlMs, {
      minimum: 60_000, maximum: 24 * 60 * 60 * 1000, name: "ROOM_IDLE_TTL_MS",
    }),
    signalRateLimit: boundedInteger(env.SIGNAL_RATE_LIMIT, DEFAULTS.signalRateLimit, {
      minimum: 10, maximum: 1000, name: "SIGNAL_RATE_LIMIT",
    }),
    authMode,
    oidcIssuer,
    oidcAudience,
    oidcClientId,
    oidcJwksUrl,
    oidcAlgorithms: OIDC_ALGORITHMS,
    oidcJwksCacheMs: boundedInteger(env.OIDC_JWKS_CACHE_MS, DEFAULTS.oidcJwksCacheMs, {
      minimum: 10_000, maximum: 60 * 60 * 1000, name: "OIDC_JWKS_CACHE_MS",
    }),
    sessionTicketTtlMs: boundedInteger(env.SESSION_TICKET_TTL_MS, DEFAULTS.sessionTicketTtlMs, {
      minimum: 5_000, maximum: 120_000, name: "SESSION_TICKET_TTL_MS",
    }),
    deviceProofMaxAgeMs: boundedInteger(env.DEVICE_PROOF_MAX_AGE_MS, DEFAULTS.deviceProofMaxAgeMs, {
      minimum: 10_000, maximum: 5 * 60 * 1000, name: "DEVICE_PROOF_MAX_AGE_MS",
    }),
    turnUrls,
    turnSharedSecret,
    turnRealm: String(env.TURN_REALM || DEFAULTS.turnRealm).trim(),
    turnCredentialTtlMs: boundedInteger(env.TURN_CREDENTIAL_TTL_MS, DEFAULTS.turnCredentialTtlMs, {
      minimum: 60_000, maximum: 24 * 60 * 60 * 1000, name: "TURN_CREDENTIAL_TTL_MS",
    }),
    edgeTurnServers: Object.freeze(edgeTurnServers),
    peerEdgeFallbackMs,
    infrastructureTurnFallbackMs,
    mediaE2eeMode,
    peerMediaRelayEnabled: booleanValue(
      env.PEER_MEDIA_RELAY_ENABLED,
      DEFAULTS.peerMediaRelayEnabled,
      "PEER_MEDIA_RELAY_ENABLED",
    ),
    peerMediaRelayMinParticipants: boundedInteger(
      env.PEER_MEDIA_RELAY_MIN_PARTICIPANTS,
      DEFAULTS.peerMediaRelayMinParticipants,
      { minimum: 3, maximum: 20, name: "PEER_MEDIA_RELAY_MIN_PARTICIPANTS" },
    ),
    peerMediaRelayMaxChildren: boundedInteger(
      env.PEER_MEDIA_RELAY_MAX_CHILDREN,
      DEFAULTS.peerMediaRelayMaxChildren,
      { minimum: 2, maximum: 5, name: "PEER_MEDIA_RELAY_MAX_CHILDREN" },
    ),
    peerMediaRelayMaxHops: boundedInteger(
      env.PEER_MEDIA_RELAY_MAX_HOPS,
      DEFAULTS.peerMediaRelayMaxHops,
      { minimum: 1, maximum: 4, name: "PEER_MEDIA_RELAY_MAX_HOPS" },
    ),
    peerRouteLeaseMs,
    peerRouteRenewMs,
    peerRelayHealthWindowMs: boundedInteger(
      env.PEER_RELAY_HEALTH_WINDOW_MS,
      DEFAULTS.peerRelayHealthWindowMs,
      { minimum: 10_000, maximum: 120_000, name: "PEER_RELAY_HEALTH_WINDOW_MS" },
    ),
    peerRelayHealthCooldownMs: boundedInteger(
      env.PEER_RELAY_HEALTH_COOLDOWN_MS,
      DEFAULTS.peerRelayHealthCooldownMs,
      { minimum: 30_000, maximum: 10 * 60_000, name: "PEER_RELAY_HEALTH_COOLDOWN_MS" },
    ),
    peerDataOverlayEnabled,
    pairWorkspaceEnabled: booleanValue(
      env.PAIR_WORKSPACE_ENABLED,
      DEFAULTS.pairWorkspaceEnabled,
      "PAIR_WORKSPACE_ENABLED",
    ),
    pairWorkspaceDb: String(env.PAIR_WORKSPACE_DB || DEFAULTS.pairWorkspaceDb).trim(),
    activeSpeakerLimit: boundedInteger(env.ACTIVE_SPEAKER_LIMIT, DEFAULTS.activeSpeakerLimit, {
      minimum: 2, maximum: 5, name: "ACTIVE_SPEAKER_LIMIT",
    }),
    mediaAgents: Object.freeze(mediaAgents),
    mediaAgentLeaseMs,
    mediaAgentRenewMs,
    mediaAgentMaxStandbys: boundedInteger(
      env.MEDIA_AGENT_MAX_STANDBYS,
      DEFAULTS.mediaAgentMaxStandbys,
      { minimum: 0, maximum: 2, name: "MEDIA_AGENT_MAX_STANDBYS" },
    ),
    mediaAgentMinParticipants: boundedInteger(
      env.MEDIA_AGENT_MIN_PARTICIPANTS,
      DEFAULTS.mediaAgentMinParticipants,
      { minimum: 3, maximum: 20, name: "MEDIA_AGENT_MIN_PARTICIPANTS" },
    ),
    mediaAgentShardMinParticipants: boundedInteger(
      env.MEDIA_AGENT_SHARD_MIN_PARTICIPANTS,
      DEFAULTS.mediaAgentShardMinParticipants,
      { minimum: 3, maximum: 20, name: "MEDIA_AGENT_SHARD_MIN_PARTICIPANTS" },
    ),
    mediaAgentTakeoverTtlMs: boundedInteger(
      env.MEDIA_AGENT_TAKEOVER_TTL_MS,
      DEFAULTS.mediaAgentTakeoverTtlMs,
      { minimum: 10_000, maximum: 60_000, name: "MEDIA_AGENT_TAKEOVER_TTL_MS" },
    ),
    mediaAgentRateLimit: boundedInteger(
      env.MEDIA_AGENT_RATE_LIMIT,
      DEFAULTS.mediaAgentRateLimit,
      { minimum: 60, maximum: 2_000, name: "MEDIA_AGENT_RATE_LIMIT" },
    ),
    mediaAgentSelfServiceEnabled,
    mediaAgentRegistrationDb,
    mediaAgentArtifactDir,
    mediaAgentEnrollmentTtlMs: boundedInteger(
      env.MEDIA_AGENT_ENROLLMENT_TTL_MS,
      DEFAULTS.mediaAgentEnrollmentTtlMs,
      { minimum: 60_000, maximum: 30 * 60_000, name: "MEDIA_AGENT_ENROLLMENT_TTL_MS" },
    ),
    mediaAgentMaxPerPrincipal: boundedInteger(
      env.MEDIA_AGENT_MAX_PER_PRINCIPAL,
      DEFAULTS.mediaAgentMaxPerPrincipal,
      { minimum: 1, maximum: 5, name: "MEDIA_AGENT_MAX_PER_PRINCIPAL" },
    ),
    mediaAgentEnrollmentRateLimit: boundedInteger(
      env.MEDIA_AGENT_ENROLLMENT_RATE_LIMIT,
      DEFAULTS.mediaAgentEnrollmentRateLimit,
      { minimum: 1, maximum: 20, name: "MEDIA_AGENT_ENROLLMENT_RATE_LIMIT" },
    ),
    broadcastWhipEndpoint,
    broadcastWhipProfile,
    broadcastWhipRedirectOrigins: Object.freeze(broadcastWhipRedirectOrigins),
    broadcastWhipTrickleIce,
    broadcastWhipAudioCodecs: Object.freeze(mediaTypes(
      env.BROADCAST_WHIP_AUDIO_CODECS,
      DEFAULTS.broadcastWhipAudioCodecs,
      "audio",
      "BROADCAST_WHIP_AUDIO_CODECS",
    )),
    broadcastWhipVideoCodecs: Object.freeze(mediaTypes(
      env.BROADCAST_WHIP_VIDEO_CODECS,
      DEFAULTS.broadcastWhipVideoCodecs,
      "video",
      "BROADCAST_WHIP_VIDEO_CODECS",
    )),
    broadcastWhipRequestTimeoutMs: boundedInteger(
      env.BROADCAST_WHIP_REQUEST_TIMEOUT_MS,
      DEFAULTS.broadcastWhipRequestTimeoutMs,
      { minimum: 1_000, maximum: 30_000, name: "BROADCAST_WHIP_REQUEST_TIMEOUT_MS" },
    ),
    broadcastWhipIceGatheringTimeoutMs: boundedInteger(
      env.BROADCAST_WHIP_ICE_GATHERING_TIMEOUT_MS,
      DEFAULTS.broadcastWhipIceGatheringTimeoutMs,
      { minimum: 1_000, maximum: 30_000, name: "BROADCAST_WHIP_ICE_GATHERING_TIMEOUT_MS" },
    ),
    broadcastWhipConnectionTimeoutMs: boundedInteger(
      env.BROADCAST_WHIP_CONNECTION_TIMEOUT_MS,
      DEFAULTS.broadcastWhipConnectionTimeoutMs,
      { minimum: 1_000, maximum: 60_000, name: "BROADCAST_WHIP_CONNECTION_TIMEOUT_MS" },
    ),
    broadcastWhipRetryBudget: boundedInteger(
      env.BROADCAST_WHIP_RETRY_BUDGET,
      DEFAULTS.broadcastWhipRetryBudget,
      { minimum: 0, maximum: 2, name: "BROADCAST_WHIP_RETRY_BUDGET" },
    ),
  });
}
