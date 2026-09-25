import { createEdgeTurnCredentials, createTurnCredentials } from "./turn-credentials.js";

// TURN REST usernames are "<unix expiry>:<opaque principal>"; the earliest one
// bounds how long the whole policy stays usable for a new TURN allocation.
function credentialExpiry(servers) {
  const expiries = servers.flatMap((server) => {
    const match = typeof server.username === "string" ? /^(\d+):/.exec(server.username) : null;
    return match ? [Number(match[1]) * 1000] : [];
  });
  return expiries.length ? Math.min(...expiries) : null;
}

/**
 * Builds the staged ICE policy of one authorized room participant. Used by the
 * session admission and by the membership-bound credential refresh so both
 * issue byte-identical shapes.
 */
export function issueIcePolicy(config, principal, { now = Date.now(), ttlMs = config.turnCredentialTtlMs } = {}) {
  const directIceServers = config.stunUrls.map((urls) => ({ urls }));
  const peerRelayIceServers = createEdgeTurnCredentials(config, principal, now, ttlMs);
  const issuedTurn = createTurnCredentials(config, principal, now, ttlMs);
  const infrastructureRelayIceServers = [...config.turnServers, ...issuedTurn];
  return {
    icePolicy: {
      version: 1,
      directIceServers,
      peerRelayIceServers,
      infrastructureRelayIceServers,
      peerRelayAfterMs: config.peerEdgeFallbackMs,
      infrastructureRelayAfterMs: config.infrastructureTurnFallbackMs,
    },
    iceServers: [...directIceServers, ...peerRelayIceServers, ...infrastructureRelayIceServers],
    credentialsExpireAt: credentialExpiry([...peerRelayIceServers, ...issuedTurn]),
    issued: { peerEdge: peerRelayIceServers.length, infrastructure: issuedTurn.length },
  };
}
