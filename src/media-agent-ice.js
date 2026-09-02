import { createEdgeTurnCredentials, createTurnCredentials } from "./turn-credentials.js";

function nativeIceServer(server) {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return Object.freeze({
    urls: Object.freeze([...urls]),
    ...(typeof server.username === "string" ? { username: server.username } : {}),
    ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
    ...(typeof server.credentialType === "string" ? { credentialType: server.credentialType } : {}),
  });
}

export function createMediaAgentIceServers(config, agentId, now = Date.now()) {
  return Object.freeze([
    ...config.stunUrls.map((urls) => ({ urls })),
    ...createEdgeTurnCredentials(config, `media-agent:${agentId}`, now),
    ...config.turnServers,
    ...createTurnCredentials(config, `media-agent:${agentId}`, now),
  ].map(nativeIceServer));
}
