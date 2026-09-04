const CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "video/mp4",
  "text/vtt",
  "application/octet-stream",
]);

export class BroadcastHlsProxyError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = "BroadcastHlsProxyError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new BroadcastHlsProxyError(code, status); }

export class BroadcastHlsProxy {
  #sessions;
  #gatewayOrigin;
  #fetch;

  constructor({ sessions, gatewayOrigin, fetchImpl = fetch }) {
    if (!sessions || typeof sessions.create !== "function" || typeof sessions.authorize !== "function") {
      fail("invalid_broadcast_hls_proxy_configuration", 500);
    }
    let parsed;
    try { parsed = new URL(gatewayOrigin); } catch { fail("invalid_broadcast_hls_proxy_configuration", 500); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.pathname !== "/"
      || parsed.username || parsed.password || parsed.search || parsed.hash || typeof fetchImpl !== "function") {
      fail("invalid_broadcast_hls_proxy_configuration", 500);
    }
    this.#sessions = sessions;
    this.#gatewayOrigin = parsed.origin;
    this.#fetch = fetchImpl;
  }

  createSession(input) { return this.#sessions.create(input); }

  closeSession(input) { return this.#sessions.close(input); }

  async fetchMedia(input) {
    const range = input.range || "";
    if (typeof range !== "string" || (range && !/^bytes=\d{0,16}-\d{0,16}$/.test(range))) {
      fail("broadcast_playback_not_found", 404);
    }
    const authorization = await this.#sessions.authorize(input);
    let response;
    try {
      response = await this.#fetch(new URL(authorization.upstreamPath, this.#gatewayOrigin), {
        method: input.method,
        headers: {
          authorization: authorization.authorizationHeader,
          ...(range ? { range } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail("broadcast_gateway_unavailable", 502);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      fail("broadcast_playback_not_found", 404);
    }
    if (!response.ok && response.status !== 206) fail("broadcast_gateway_unavailable", 502);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
    if (!CONTENT_TYPES.has(contentType)) fail("broadcast_gateway_invalid_response", 502);
    const contentLength = response.headers.get("content-length");
    if (contentLength && (!/^\d{1,9}$/.test(contentLength) || Number(contentLength) > 24 * 1024 * 1024)) {
      fail("broadcast_gateway_invalid_response", 502);
    }
    let streamedBytes = 0;
    const body = input.method === "HEAD" || !response.body ? null : response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > 24 * 1024 * 1024) controller.error(new BroadcastHlsProxyError("broadcast_gateway_invalid_response", 502));
        else controller.enqueue(chunk);
      },
    }));
    return Object.freeze({
      status: response.status,
      headers: Object.freeze({
        "content-type": response.headers.get("content-type") || contentType,
        "cache-control": authorization.cacheControl,
        ...(contentLength ? { "content-length": contentLength } : {}),
        ...(response.headers.get("content-range") ? { "content-range": response.headers.get("content-range") } : {}),
        ...(response.headers.get("accept-ranges") ? { "accept-ranges": response.headers.get("accept-ranges") } : {}),
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      }),
      body,
    });
  }
}
