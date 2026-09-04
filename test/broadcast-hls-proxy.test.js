import assert from "node:assert/strict";
import test from "node:test";

import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";

function proxy(status = 200, contentType = "application/vnd.apple.mpegurl") {
  const calls = [];
  const sessions = {
    create: async (value) => value,
    close: () => null,
    authorize: async () => ({
      upstreamPath: "/res_aaaaaaaaaaaaaaaa/index.m3u8?_HLS_msn=2",
      authorizationHeader: "Bearer secret-never-returned",
      cacheControl: "private, no-store, max-age=0",
    }),
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response("#EXTM3U", { status, headers: { "content-type": contentType, "content-length": "8" } });
  };
  return { calls, value: new BroadcastHlsProxy({ sessions, gatewayOrigin: "http://broadcast-gateway:8888", fetchImpl }) };
}

test("HLS proxy uses only the fixed gateway and keeps bearer data out of its response", async () => {
  const { calls, value } = proxy();
  const response = await value.fetchMedia({
    method: "GET", resourceRef: "res_aaaaaaaaaaaaaaaa", file: "index.m3u8",
    query: "_HLS_msn=2", cookieHeader: "cookie", origin: "https://webrtc.ananta.de", range: "",
  });
  assert.equal(calls[0].url, "http://broadcast-gateway:8888/res_aaaaaaaaaaaaaaaa/index.m3u8?_HLS_msn=2");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-never-returned");
  assert.deepEqual(response.headers, {
    "content-type": "application/vnd.apple.mpegurl",
    "cache-control": "private, no-store, max-age=0",
    "content-length": "8",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  assert.doesNotMatch(JSON.stringify(response.headers), /secret-never-returned/);
});

test("HLS proxy bounds range, redirects, content type, size and private misses", async () => {
  await assert.rejects(proxy().value.fetchMedia({ range: "items=1-2" }), /not_found/);
  await assert.rejects(proxy(401).value.fetchMedia({ method: "GET", range: "" }), /not_found/);
  await assert.rejects(proxy(500).value.fetchMedia({ method: "GET", range: "" }), /gateway_unavailable/);
  await assert.rejects(proxy(200, "text/html").value.fetchMedia({ method: "GET", range: "" }), /invalid_response/);
});
