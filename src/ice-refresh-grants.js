import crypto from "node:crypto";

export const ICE_REFRESH_PATH = "/api/ice-credentials";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class IceRefreshError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "IceRefreshError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Membership-bound capability to re-issue TURN credentials for one signaling
 * session. A grant is issued with the session ticket, becomes redeemable only
 * once its WebSocket joined the room, and dies with that membership. It never
 * widens authority: the refreshed credentials carry the same principal and
 * lifetime bounds as the ones issued at admission.
 */
export class IceRefreshGrantStore {
  #grants = new Map();
  #bindTtlMs;
  #maxPerWindow;
  #windowMs;

  constructor({ bindTtlMs = 35_000, maxPerWindow = 30, windowMs = 60_000 } = {}) {
    this.#bindTtlMs = bindTtlMs;
    this.#maxPerWindow = maxPerWindow;
    this.#windowMs = windowMs;
  }

  issue(claims, now = Date.now()) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.#grants.set(token, {
      claims: Object.freeze({ ...claims }),
      bindBy: now + this.#bindTtlMs,
      live: null,
      windowStart: now,
      redeemed: 0,
    });
    return token;
  }

  /** Binds a grant to the liveness of the membership its ticket created. */
  bind(token, live) {
    const grant = this.#grants.get(token);
    if (!grant || grant.live || typeof live !== "function") return false;
    grant.live = live;
    return true;
  }

  revoke(token) {
    this.#grants.delete(token);
  }

  redeem(token, { origin = "", now = Date.now() } = {}) {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new IceRefreshError("invalid_ice_refresh", 401);
    const grant = this.#grants.get(token);
    if (!grant?.live) throw new IceRefreshError("invalid_ice_refresh", 401);
    if (!grant.live()) {
      this.#grants.delete(token);
      throw new IceRefreshError("invalid_ice_refresh", 401);
    }
    if (grant.claims.origin && origin && grant.claims.origin !== origin) {
      throw new IceRefreshError("ice_refresh_origin_mismatch", 403);
    }
    if (now - grant.windowStart >= this.#windowMs) {
      grant.windowStart = now;
      grant.redeemed = 0;
    }
    if (grant.redeemed >= this.#maxPerWindow) throw new IceRefreshError("rate_limited", 429);
    grant.redeemed += 1;
    return grant.claims;
  }

  prune(now = Date.now()) {
    for (const [token, grant] of this.#grants) {
      if (grant.live ? !grant.live() : grant.bindBy < now) this.#grants.delete(token);
    }
  }

  get size() {
    return this.#grants.size;
  }
}
