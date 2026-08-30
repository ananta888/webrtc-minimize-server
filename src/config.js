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
  signalRateLimit: 120,
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
  peerMediaRelayEnabled: true,
  peerMediaRelayMinParticipants: 6,
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
});

const AUTH_MODES = new Set(["disabled", "optional", "required"]);
const OIDC_ALGORITHMS = Object.freeze(["RS256", "ES256", "RS384", "RS512"]);

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
    peerDataOverlayEnabled: booleanValue(
      env.PEER_DATA_OVERLAY_ENABLED,
      DEFAULTS.peerDataOverlayEnabled,
      "PEER_DATA_OVERLAY_ENABLED",
    ),
    pairWorkspaceEnabled: booleanValue(
      env.PAIR_WORKSPACE_ENABLED,
      DEFAULTS.pairWorkspaceEnabled,
      "PAIR_WORKSPACE_ENABLED",
    ),
    pairWorkspaceDb: String(env.PAIR_WORKSPACE_DB || DEFAULTS.pairWorkspaceDb).trim(),
    activeSpeakerLimit: boundedInteger(env.ACTIVE_SPEAKER_LIMIT, DEFAULTS.activeSpeakerLimit, {
      minimum: 2, maximum: 5, name: "ACTIVE_SPEAKER_LIMIT",
    }),
  });
}
