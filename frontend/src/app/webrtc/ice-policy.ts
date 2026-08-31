export type IcePathClass = "direct" | "peer-edge" | "infrastructure-relay" | "unknown";

export interface IceTierPolicy {
  readonly version: 1;
  readonly directIceServers: readonly RTCIceServer[];
  readonly peerRelayIceServers: readonly RTCIceServer[];
  readonly infrastructureRelayIceServers: readonly RTCIceServer[];
  readonly peerRelayAfterMs: number;
  readonly infrastructureRelayAfterMs: number;
}

const SERVER_KEYS = new Set(["urls", "username", "credential", "credentialType"]);
const POLICY_KEYS = new Set([
  "version",
  "directIceServers",
  "peerRelayIceServers",
  "infrastructureRelayIceServers",
  "peerRelayAfterMs",
  "infrastructureRelayAfterMs",
]);

function parseServer(raw: unknown, allowedSchemes: ReadonlySet<string>): RTCIceServer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !SERVER_KEYS.has(key))) return null;
  const urls = typeof value["urls"] === "string"
    ? [value["urls"]]
    : Array.isArray(value["urls"]) && value["urls"].every((url) => typeof url === "string")
      ? value["urls"] as string[]
      : null;
  if (!urls || urls.length < 1 || urls.length > 8 || urls.some((url) => {
    const scheme = /^([a-z]+):/i.exec(url)?.[1]?.toLowerCase();
    return !scheme || !allowedSchemes.has(scheme) || url.length > 1_024 || /\s/.test(url);
  })) return null;
  if (value["username"] !== undefined && (typeof value["username"] !== "string" || value["username"].length > 512)) return null;
  if (value["credential"] !== undefined && (typeof value["credential"] !== "string" || value["credential"].length > 512)) return null;
  if (value["credentialType"] !== undefined && value["credentialType"] !== "password") return null;
  const server: RTCIceServer = {
    urls: urls.length === 1 ? urls[0] : [...urls],
    ...(typeof value["username"] === "string" ? { username: value["username"] } : {}),
    ...(typeof value["credential"] === "string" ? { credential: value["credential"] } : {}),
    ...(value["credentialType"] === "password" ? { credentialType: "password" as const } : {}),
  };
  return Object.freeze(server);
}

function parseServers(raw: unknown, allowedSchemes: ReadonlySet<string>): readonly RTCIceServer[] | null {
  if (!Array.isArray(raw) || raw.length > 16) return null;
  const servers = raw.map((entry) => parseServer(entry, allowedSchemes));
  return servers.some((entry) => entry === null)
    ? null
    : Object.freeze(servers as RTCIceServer[]);
}

export function parseIceTierPolicy(raw: unknown): IceTierPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !POLICY_KEYS.has(key)) || value["version"] !== 1) return null;
  const directIceServers = parseServers(value["directIceServers"], new Set(["stun", "stuns"]));
  const peerRelayIceServers = parseServers(value["peerRelayIceServers"], new Set(["turn", "turns"]));
  const infrastructureRelayIceServers = parseServers(
    value["infrastructureRelayIceServers"],
    new Set(["turn", "turns"]),
  );
  const peerRelayAfterMs = Number(value["peerRelayAfterMs"]);
  const infrastructureRelayAfterMs = Number(value["infrastructureRelayAfterMs"]);
  if (!directIceServers || !peerRelayIceServers || !infrastructureRelayIceServers
    || !Number.isSafeInteger(peerRelayAfterMs) || peerRelayAfterMs < 1_000 || peerRelayAfterMs > 30_000
    || !Number.isSafeInteger(infrastructureRelayAfterMs) || infrastructureRelayAfterMs < 2_000
    || infrastructureRelayAfterMs > 60_000 || infrastructureRelayAfterMs <= peerRelayAfterMs) return null;
  return Object.freeze({
    version: 1,
    directIceServers,
    peerRelayIceServers,
    infrastructureRelayIceServers,
    peerRelayAfterMs,
    infrastructureRelayAfterMs,
  });
}

export function cumulativeIceServers(policy: IceTierPolicy, tier: 0 | 1 | 2): readonly RTCIceServer[] {
  return [
    ...policy.directIceServers,
    ...(tier >= 1 ? policy.peerRelayIceServers : []),
    ...(tier >= 2 ? policy.infrastructureRelayIceServers : []),
  ];
}

export function iceServerUrls(servers: readonly RTCIceServer[]): ReadonlySet<string> {
  return new Set(servers.flatMap((server) => typeof server.urls === "string" ? [server.urls] : [...server.urls]));
}
