import crypto from "node:crypto";

export function createTurnCredentials(config, principal, now = Date.now()) {
  if (!config.turnSharedSecret || config.turnUrls.length === 0) return [];
  const expiresAt = Math.floor((now + config.turnCredentialTtlMs) / 1000);
  const opaquePrincipal = crypto.createHash("sha256").update(principal).digest("hex").slice(0, 20);
  const username = `${expiresAt}:${opaquePrincipal}`;
  const credential = crypto.createHmac("sha1", config.turnSharedSecret)
    .update(username)
    .digest("base64");
  return [Object.freeze({
    urls: [...config.turnUrls],
    username,
    credential,
    credentialType: "password",
  })];
}
