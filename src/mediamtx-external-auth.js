import net from "node:net";

import { BroadcastGrantError } from "./broadcast-grant-authority.js";

const FIELDS = new Set([
  "user", "password", "token", "ip", "action", "path", "protocol", "id", "query", "userAgent",
]);
const PATH = /^res_[A-Za-z0-9_-]{16,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MediaMtxExternalAuthError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = "MediaMtxExternalAuthError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new MediaMtxExternalAuthError(code, status);
}

function bounded(value, maximum) {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeMediaMtxAuthRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.size
    || Object.keys(value).some((field) => !FIELDS.has(field))
    || value.user !== "" || value.password !== ""
    || !bounded(value.token, 8 * 1024) || value.token.length < 16
    || !bounded(value.ip, 64) || net.isIP(value.ip) === 0
    || !new Set(["publish", "read"]).has(value.action)
    || !PATH.test(value.path || "")
    || !new Set(["webrtc", "hls"]).has(value.protocol)
    || (value.id !== null && (!bounded(value.id, 64) || !UUID.test(value.id)))
    || !bounded(value.query, 2_048) || /(?:^|&)token=/i.test(value.query)
    || !bounded(value.userAgent, 512)) {
    fail("invalid_mediamtx_auth_request", 400);
  }
  if ((value.action === "publish" && value.protocol !== "webrtc")
    || (value.action === "read" && value.protocol !== "webrtc" && value.protocol !== "hls")) {
    fail("mediamtx_action_denied");
  }
  return Object.freeze({ ...value });
}

export class MediaMtxExternalAuthService {
  #authority;
  #rate;
  #now;
  #maximumPerWindow;
  #windowMs;

  constructor(options) {
    if (!options?.authority || typeof options.authority.authorizeGatewayBearer !== "function") {
      fail("invalid_mediamtx_auth_configuration", 500);
    }
    this.#authority = options.authority;
    this.#rate = new Map();
    this.#now = options.now || Date.now;
    this.#maximumPerWindow = options.maximumPerWindow ?? 120;
    this.#windowMs = options.windowMs ?? 10_000;
    if (!Number.isSafeInteger(this.#maximumPerWindow) || this.#maximumPerWindow < 1
      || !Number.isSafeInteger(this.#windowMs) || this.#windowMs < 1_000) {
      fail("invalid_mediamtx_auth_configuration", 500);
    }
  }

  #consumeRate(ip, now) {
    const current = this.#rate.get(ip);
    const entry = !current || current.startedAt + this.#windowMs <= now
      ? { startedAt: now, count: 1 }
      : { startedAt: current.startedAt, count: current.count + 1 };
    this.#rate.set(ip, entry);
    if (entry.count > this.#maximumPerWindow) fail("mediamtx_auth_rate_limited", 429);
  }

  async authorize(value) {
    const request = normalizeMediaMtxAuthRequest(value);
    const now = this.#now();
    this.#consumeRate(request.ip, now);
    const path = request.action === "publish"
      ? `/broadcast/ingest/${request.path}`
      : `/broadcast/play/${request.path}`;
    try {
      if (request.action === "publish") {
        return await this.#authority.authorizeGatewayBearer(`Bearer ${request.token}`, {
          action: "whip:create",
          path,
          grantKinds: ["publisher", "packager"],
        }, now);
      }
      if (request.protocol === "webrtc") {
        return await this.#authority.authorizeGatewayBearer(`Bearer ${request.token}`, {
          action: "whep:read",
          path,
          grantKinds: ["playback"],
        }, now);
      }
      const grant = await this.#authority.authorizeGatewayBearer(`Bearer ${request.token}`, {
        action: "playback:manifest",
        path,
        grantKinds: ["playback"],
      }, now);
      await this.#authority.authorizeGatewayBearer(`Bearer ${request.token}`, {
        action: "playback:segment",
        path,
        grantKinds: ["playback"],
      }, now);
      return grant;
    } catch (error) {
      if (error instanceof BroadcastGrantError) fail(error.code, error.status === 429 ? 429 : 401);
      throw error;
    }
  }

  prune() {
    const now = this.#now();
    for (const [ip, entry] of this.#rate) if (entry.startedAt + this.#windowMs <= now) this.#rate.delete(ip);
  }
}
