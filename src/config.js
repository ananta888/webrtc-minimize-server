const DEFAULTS = Object.freeze({
  host: "0.0.0.0",
  port: 8080,
  publicOrigin: "",
  stunUrls: ["stun:stun.l.google.com:19302"],
  turnServers: [],
  maxRoomParticipants: 4,
  roomIdleTtlMs: 60 * 60 * 1000,
  signalRateLimit: 120,
});

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

export function loadConfig(env = process.env) {
  const publicOrigin = String(env.PUBLIC_ORIGIN || DEFAULTS.publicOrigin).replace(/\/$/, "");
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.pathname !== "/") {
      throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path");
    }
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
      { minimum: 2, maximum: 4, name: "MAX_ROOM_PARTICIPANTS" },
    ),
    roomIdleTtlMs: boundedInteger(env.ROOM_IDLE_TTL_MS, DEFAULTS.roomIdleTtlMs, {
      minimum: 60_000, maximum: 24 * 60 * 60 * 1000, name: "ROOM_IDLE_TTL_MS",
    }),
    signalRateLimit: boundedInteger(env.SIGNAL_RATE_LIMIT, DEFAULTS.signalRateLimit, {
      minimum: 10, maximum: 1000, name: "SIGNAL_RATE_LIMIT",
    }),
  });
}
