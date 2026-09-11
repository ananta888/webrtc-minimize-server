import assert from "node:assert/strict";
import test from "node:test";

import {
  MediaMtxControlClient,
  MediaMtxControlError,
  createMediaMtxControlClient,
  normalizeMediaMtxControlOrigin,
} from "../src/mediamtx-control.js";

const RESOURCE = "res_aaaaaaaaaaaaaaaa";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HLS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const errorCode = (code) => (error) => error instanceof MediaMtxControlError && error.code === code;

function client(handler) {
  return new MediaMtxControlClient({
    origin: "http://127.0.0.1:9997",
    fetchImpl: async (url, options) => handler(String(url), options),
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

test("control origin is loopback-or-docker HTTP :9997 only", () => {
  assert.equal(normalizeMediaMtxControlOrigin(""), "");
  assert.equal(createMediaMtxControlClient(""), null);
  assert.equal(normalizeMediaMtxControlOrigin("http://127.0.0.1:9997"), "http://127.0.0.1:9997");
  assert.equal(normalizeMediaMtxControlOrigin("http://10.255.254.3:9997"), "http://10.255.254.3:9997");
  assert.equal(normalizeMediaMtxControlOrigin("http://broadcast-gateway:9997"), "http://broadcast-gateway:9997");
  for (const origin of [
    "https://127.0.0.1:9997", "http://127.0.0.1:9998", "http://example.test:9997",
    "http://127.0.0.1:9997/v3", "http://user:pass@127.0.0.1:9997", "http://[::1]:9997",
  ]) {
    assert.throws(() => normalizeMediaMtxControlOrigin(origin), errorCode("invalid_mediamtx_control_origin"));
  }
});

test("purge kicks publisher and HLS sessions then DELETEs only the exact res_ path", async () => {
  const calls = [];
  const control = client(async (url, options) => {
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (url.endsWith(`/v3/paths/get/${RESOURCE}`)) {
      return json(200, { name: RESOURCE, source: { type: "webRTCSession", id: SESSION }, extra: "drop" });
    }
    if (url.endsWith("/v3/hlssessions/list")) {
      return json(200, { items: [
        { id: HLS, path: RESOURCE, remoteAddr: "203.0.113.9", query: "token=secret" },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", path: "res_otherotherothero" },
      ] });
    }
    return json(200, { status: "ok" });
  });
  assert.deepEqual(await control.purgeResource(RESOURCE), { purged: true });
  assert.deepEqual(calls, [
    `GET /v3/paths/get/${RESOURCE}`,
    `POST /v3/webrtcsessions/kick/${SESSION}`,
    "GET /v3/hlssessions/list",
    `POST /v3/hlssessions/kick/${HLS}`,
    `DELETE /v3/config/paths/delete/${RESOURCE}`,
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /token|203\.0\.113/);
});

test("missing path is already gone and still DELETEs the exact resource name", async () => {
  const calls = [];
  const control = client(async (url, options) => {
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (options.method === "GET") return new Response("", { status: 404 });
    return json(404, { error: "not found" });
  });
  assert.deepEqual(await control.purgeResource(RESOURCE), { purged: true });
  assert.deepEqual(calls, [
    `GET /v3/paths/get/${RESOURCE}`,
    "GET /v3/hlssessions/list",
    `DELETE /v3/config/paths/delete/${RESOURCE}`,
  ]);
});

test("regex, foreign hosts and oversize control payloads fail closed", async () => {
  const control = client(async () => json(200, { items: Array.from({ length: 65 }, () => ({ id: SESSION, path: RESOURCE })) }));
  await assert.rejects(() => control.purgeResource("~^res_[A-Za-z0-9_-]{16,64}$"), errorCode("invalid_mediamtx_control_path"));
  await assert.rejects(() => control.purgeResource("res_short"), errorCode("invalid_mediamtx_control_path"));
  await assert.rejects(() => control.purgeResource(RESOURCE), errorCode("mediamtx_control_response_too_large"));
  assert.throws(() => new MediaMtxControlClient({ origin: "http://192.168.0.1:9997" }),
    errorCode("invalid_mediamtx_control_origin"));
});
