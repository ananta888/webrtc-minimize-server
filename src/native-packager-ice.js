import { createEdgeTurnCredentials, createTurnCredentials } from "./turn-credentials.js";

function normalized(server) {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return Object.freeze({
    urls: Object.freeze([...urls]),
    ...(typeof server.username === "string" ? { username: server.username } : {}),
    ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
    ...(typeof server.credentialType === "string" ? { credentialType: server.credentialType } : {}),
  });
}

export function createNativePackagerIceServers(config, packagerId, now = Date.now()) {
  return Object.freeze([
    ...config.stunUrls.map((urls) => ({ urls })),
    ...createEdgeTurnCredentials(config, `native-packager:${packagerId}`, now),
    ...createTurnCredentials(config, `native-packager:${packagerId}`, now),
  ].map(normalized));
}
