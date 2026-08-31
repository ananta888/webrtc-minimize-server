import crypto from "node:crypto";

const MAX_EDGE_TURN_CREDENTIAL_TTL_MS = 10 * 60 * 1000;

export function createTurnCredentials(config, principal, now = Date.now()) {
  return createCredential(
    config.turnUrls,
    config.turnSharedSecret,
    config.turnCredentialTtlMs,
    principal,
    now,
  );
}

export function createEdgeTurnCredentials(config, principal, now = Date.now()) {
  return (config.edgeTurnServers || []).flatMap((server) => createCredential(
    server.urls,
    server.sharedSecret,
    Math.min(config.turnCredentialTtlMs, MAX_EDGE_TURN_CREDENTIAL_TTL_MS),
    principal,
    now,
  ));
}

function createCredential(urls, sharedSecret, ttlMs, principal, now) {
  if (!sharedSecret || urls.length === 0) return [];
  const expiresAt = Math.floor((now + ttlMs) / 1000);
  const opaquePrincipal = crypto.createHash("sha256").update(principal).digest("hex").slice(0, 20);
  const username = `${expiresAt}:${opaquePrincipal}`;
  const credential = crypto.createHmac("sha1", sharedSecret)
    .update(username)
    .digest("base64");
  return [Object.freeze({
    urls: [...urls],
    username,
    credential,
    credentialType: "password",
  })];
}
