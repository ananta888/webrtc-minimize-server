import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthenticationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export function bearerToken(header) {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(String(header));
  if (!match) throw new AuthenticationError("invalid_authorization_header");
  return match[1];
}

function displayName(payload) {
  const candidate = String(payload.preferred_username || payload.name || payload.email || payload.sub)
    .trim()
    .replace(/\s+/g, " ");
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return String(payload.sub).slice(0, 40);
  return candidate.slice(0, 40);
}

export function createOidcVerifier(config, options = {}) {
  if (config.authMode === "disabled") {
    return Object.freeze({
      async verify() {
        throw new AuthenticationError("authentication_disabled");
      },
    });
  }
  const jwks = options.jwks || createRemoteJWKSet(new URL(config.oidcJwksUrl), {
    cacheMaxAge: config.oidcJwksCacheMs,
    cooldownDuration: 5_000,
    timeoutDuration: 5_000,
  });
  return Object.freeze({
    async verify(token) {
      if (!token) throw new AuthenticationError("authentication_required");
      try {
        const { payload, protectedHeader } = await jwtVerify(token, jwks, {
          issuer: config.oidcIssuer,
          audience: config.oidcAudience,
          algorithms: config.oidcAlgorithms,
          requiredClaims: ["iss", "sub", "aud", "exp"],
        });
        if (!payload.sub) throw new AuthenticationError("token_subject_missing");
        return Object.freeze({
          subject: payload.sub,
          issuer: payload.iss,
          displayName: displayName(payload),
          algorithm: protectedHeader.alg,
        });
      } catch (error) {
        if (error instanceof AuthenticationError) throw error;
        throw new AuthenticationError("invalid_access_token");
      }
    },
  });
}
