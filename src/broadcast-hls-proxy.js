import { BroadcastHlsTraffic } from "./broadcast-hls-traffic.js";
import { BroadcastHlsScopedBudget } from "./broadcast-hls-scoped-budget.js";

const CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "video/mp4",
  "text/vtt",
  "application/octet-stream",
]);
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

function cancelBody(body, reason) {
  // Cancellation must not retain a viewer slot or cause an unhandled rejection
  // when an upstream transport throws, rejects or never settles its cleanup.
  try { void Promise.resolve(body?.cancel(reason)).catch(() => {}); } catch { /* no upstream error content */ }
}

function boundedResponseBody(body, { idleTimeoutMs, streamTimeoutMs, release, traffic, budget }) {
  const reader = body.getReader();
  let finished = false;
  let idleTimer;
  let totalTimer;
  let streamedBytes = 0;
  const finish = (outcome = "failed") => {
    if (finished) return false;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    release(outcome);
    return true;
  };
  const failStream = (controller, code, status) => {
    if (!finish()) return;
    cancelBody(reader, code);
    controller.error(new BroadcastHlsProxyError(code, status));
  };
  const resetIdle = controller => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failStream(controller, "broadcast_gateway_stream_timeout", 504), idleTimeoutMs);
  };
  return new ReadableStream({
    start(controller) {
      totalTimer = setTimeout(() => failStream(controller, "broadcast_gateway_stream_timeout", 504), streamTimeoutMs);
      resetIdle(controller);
    },
    async pull(controller) {
      if (finished) return;
      try {
        const result = await reader.read();
        // Timeout/cancel may resolve the outstanding read after downstream is
        // already closed. Never enqueue, close or release that generation twice.
        if (finished) return;
        if (result.done) {
          finish("completed");
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)
          || result.value.byteLength > MAX_RESPONSE_BYTES - streamedBytes) {
          failStream(controller, "broadcast_gateway_invalid_response", 502);
          return;
        }
        if (!budget.bytes(result.value.byteLength)) {
          failStream(controller, "broadcast_playback_temporarily_unavailable", 429);
          return;
        }
        streamedBytes += result.value.byteLength;
        controller.enqueue(result.value);
        traffic.bytes(result.value.byteLength);
        resetIdle(controller);
      } catch {
        failStream(controller, "broadcast_gateway_stream_failed", 502);
      }
    },
    cancel() {
      if (finish("cancelled")) cancelBody(reader, "broadcast_viewer_cancelled");
    },
  }, { highWaterMark: 0 });
}

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
  #maximumConcurrentRequests;
  #maximumConcurrentPerSession;
  #idleTimeoutMs;
  #streamTimeoutMs;
  #activeRequests = 0;
  #activeBySession = new Map();
  #traffic = new BroadcastHlsTraffic();
  #budget;

  constructor({
    sessions,
    gatewayOrigin,
    fetchImpl = fetch,
    maximumConcurrentRequests = 64,
    maximumConcurrentPerSession = 6,
    idleTimeoutMs = 5_000,
    streamTimeoutMs = 30_000,
    maximumRequestsPerSecond,
    maximumEgressBitsPerSecond,
    egressBurstBytes,
    scopedBudgets,
    clock,
  }) {
    if (!sessions || typeof sessions.create !== "function" || typeof sessions.renew !== "function"
      || typeof sessions.authorize !== "function") {
      fail("invalid_broadcast_hls_proxy_configuration", 500);
    }
    let parsed;
    try { parsed = new URL(gatewayOrigin); } catch { fail("invalid_broadcast_hls_proxy_configuration", 500); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.pathname !== "/"
      || parsed.username || parsed.password || parsed.search || parsed.hash || typeof fetchImpl !== "function"
      || !Number.isSafeInteger(maximumConcurrentRequests) || maximumConcurrentRequests < 1 || maximumConcurrentRequests > 10_000
      || !Number.isSafeInteger(maximumConcurrentPerSession) || maximumConcurrentPerSession < 1
      || maximumConcurrentPerSession > maximumConcurrentRequests
      || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 60_000
      || !Number.isSafeInteger(streamTimeoutMs) || streamTimeoutMs < idleTimeoutMs || streamTimeoutMs > 5 * 60_000) {
      fail("invalid_broadcast_hls_proxy_configuration", 500);
    }
    this.#sessions = sessions;
    this.#gatewayOrigin = parsed.origin;
    this.#fetch = fetchImpl;
    this.#maximumConcurrentRequests = maximumConcurrentRequests;
    this.#maximumConcurrentPerSession = maximumConcurrentPerSession;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#streamTimeoutMs = streamTimeoutMs;
    if (scopedBudgets !== undefined && (!scopedBudgets || typeof scopedBudgets !== "object" || Array.isArray(scopedBudgets)
      || Object.keys(scopedBudgets).some(key => !["tenant", "audience"].includes(key)))) {
      fail("invalid_broadcast_hls_proxy_configuration", 500);
    }
    this.#budget = new BroadcastHlsScopedBudget({
      deployment: { maximumRequestsPerSecond, maximumEgressBitsPerSecond, egressBurstBytes },
      tenant: scopedBudgets?.tenant, audience: scopedBudgets?.audience, clock,
    });
  }

  createSession(input) { return this.#sessions.create(input); }

  renewSession(input) { return this.#sessions.renew(input); }

  closeSession(input) { return this.#sessions.close(input); }

  trafficCounts() { return this.#traffic.snapshot(this.#activeRequests, this.#activeBySession.size); }

  async fetchMedia(input) {
    const range = input.range || "";
    if (typeof range !== "string" || (range && !/^bytes=\d{0,16}-\d{0,16}$/.test(range))) {
      fail("broadcast_playback_not_found", 404);
    }
    const authorization = await this.#sessions.authorize(input);
    const budget = this.#budget.forScope(authorization.budgetScope);
    if (!budget || !budget.request()) fail("broadcast_playback_temporarily_unavailable", 429);
    const sessionKey = authorization.sessionId || input.resourceRef || "invalid";
    const release = this.#acquire(sessionKey);
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
      release();
      fail("broadcast_gateway_unavailable", 502);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      cancelBody(response.body, "broadcast_upstream_rejected");
      release();
      fail("broadcast_playback_not_found", 404);
    }
    if (!response.ok && response.status !== 206) {
      cancelBody(response.body, "broadcast_upstream_rejected");
      release();
      fail("broadcast_gateway_unavailable", 502);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
    if (!CONTENT_TYPES.has(contentType)) {
      cancelBody(response.body, "broadcast_upstream_rejected");
      release();
      fail("broadcast_gateway_invalid_response", 502);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && (!/^\d{1,9}$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
      cancelBody(response.body, "broadcast_upstream_rejected");
      release();
      fail("broadcast_gateway_invalid_response", 502);
    }
    const body = input.method === "HEAD" || !response.body ? null : boundedResponseBody(response.body, {
      idleTimeoutMs: this.#idleTimeoutMs,
      streamTimeoutMs: this.#streamTimeoutMs,
      release,
      traffic: this.#traffic,
      budget,
    });
    if (!body) {
      cancelBody(response.body, "broadcast_body_unused");
      release("completed");
    }
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

  #acquire(sessionKey) {
    const current = this.#activeBySession.get(sessionKey) || 0;
    if (this.#activeRequests >= this.#maximumConcurrentRequests || current >= this.#maximumConcurrentPerSession) {
      fail("broadcast_playback_temporarily_unavailable", 429);
    }
    this.#activeRequests += 1;
    this.#activeBySession.set(sessionKey, current + 1);
    let released = false;
    return (outcome = "failed") => {
      if (released) return;
      released = true;
      this.#activeRequests -= 1;
      const remaining = (this.#activeBySession.get(sessionKey) || 1) - 1;
      if (remaining > 0) this.#activeBySession.set(sessionKey, remaining);
      else this.#activeBySession.delete(sessionKey);
      this.#traffic.finished(outcome);
    };
  }
}
