import net from "node:net";

const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "10.255.254.3", "broadcast-gateway"]);
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_HLS_SESSIONS = 64;

export class MediaMtxControlError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MediaMtxControlError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new MediaMtxControlError(code, status);
}

export function normalizeMediaMtxControlOrigin(value) {
  if (!value) return "";
  let parsed;
  try { parsed = new URL(value); } catch { fail("invalid_mediamtx_control_origin", 500); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== "/" || parsed.port !== "9997" || !ALLOWED_HOSTS.has(parsed.hostname)
    || (net.isIP(parsed.hostname) !== 0 && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "10.255.254.3")) {
    fail("invalid_mediamtx_control_origin", 500);
  }
  return parsed.origin;
}

export function createMediaMtxControlClient(origin, options = {}) {
  const normalized = normalizeMediaMtxControlOrigin(origin);
  return normalized ? new MediaMtxControlClient({ origin: normalized, ...options }) : null;
}

export class MediaMtxControlClient {
  #origin;
  #fetch;
  #timeoutMs;

  constructor({ origin, fetchImpl = fetch, timeoutMs = 2_000 } = {}) {
    this.#origin = normalizeMediaMtxControlOrigin(origin);
    if (!this.#origin) fail("invalid_mediamtx_control_origin", 500);
    if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 250 || timeoutMs > 5_000) {
      fail("invalid_mediamtx_control_configuration", 500);
    }
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async purgeResource(resourceRef) {
    if (!RESOURCE.test(resourceRef || "")) fail("invalid_mediamtx_control_path");
    const path = await this.#request("GET", `/v3/paths/get/${resourceRef}`, { allowNotFound: true });
    const sourceId = path?.source?.type === "webRTCSession" && UUID.test(path.source.id || "")
      ? path.source.id : null;
    if (sourceId) {
      await this.#request("POST", `/v3/webrtcsessions/kick/${sourceId}`, { allowNotFound: true });
    }
    const sessions = await this.#request("GET", "/v3/hlssessions/list", { allowNotFound: true });
    for (const session of sessions?.items || []) {
      if (session.path === resourceRef && UUID.test(session.id || "")) {
        await this.#request("POST", `/v3/hlssessions/kick/${session.id}`, { allowNotFound: true });
      }
    }
    await this.#request("DELETE", `/v3/config/paths/delete/${resourceRef}`, { allowNotFound: true });
    return Object.freeze({ purged: true });
  }

  async #request(method, pathname, { allowNotFound = false } = {}) {
    const url = new URL(pathname, `${this.#origin}/`);
    if (url.origin !== this.#origin || url.search || url.hash || url.username || url.password) {
      fail("invalid_mediamtx_control_path");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await this.#fetch(url, {
        method, redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch {
      fail("mediamtx_control_unavailable", 503);
    } finally {
      clearTimeout(timer);
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) fail("mediamtx_control_rejected", response.status === 429 ? 429 : 502);
    if (method === "POST" || method === "DELETE") return Object.freeze({ ok: true });
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail("mediamtx_control_response_too_large", 502);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) fail("mediamtx_control_response_too_large", 502);
    let parsed;
    try { parsed = JSON.parse(buffer.toString("utf8")); } catch { fail("invalid_mediamtx_control_response", 502); }
    return freezeControlPayload(parsed);
  }
}

function freezeControlPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_mediamtx_control_response", 502);
  if (Array.isArray(value.items)) {
    if (value.items.length > MAX_HLS_SESSIONS) fail("mediamtx_control_response_too_large", 502);
    return Object.freeze({
      items: Object.freeze(value.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_mediamtx_control_response", 502);
        return Object.freeze({
          id: typeof item.id === "string" ? item.id : "",
          path: typeof item.path === "string" ? item.path : "",
        });
      })),
    });
  }
  const source = value.source && typeof value.source === "object" && !Array.isArray(value.source)
    ? Object.freeze({
      type: typeof value.source.type === "string" ? value.source.type : "",
      id: typeof value.source.id === "string" ? value.source.id : "",
    }) : null;
  return Object.freeze({
    name: typeof value.name === "string" ? value.name : "",
    source,
  });
}
