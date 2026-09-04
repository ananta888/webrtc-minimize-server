import assert from "node:assert/strict";
import test from "node:test";

import {
  MediaMtxExternalAuthError,
  MediaMtxExternalAuthService,
  normalizeMediaMtxAuthRequest,
} from "../src/mediamtx-external-auth.js";

const TOKEN = "synthetic-token-that-is-not-a-secret";

function request(overrides = {}) {
  return {
    user: "",
    password: "",
    token: TOKEN,
    ip: "172.20.0.3",
    action: "publish",
    path: "res_aaaaaaaaaaaaaaaa",
    protocol: "webrtc",
    id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    query: "",
    userAgent: "MediaMTX/1.20.1",
    ...overrides,
  };
}

const errorCode = (code) => (error) => error instanceof MediaMtxExternalAuthError && error.code === code;

test("MediaMTX auth maps only bounded WHIP, WHEP and HLS requests to grant actions", async () => {
  const calls = [];
  const authority = {
    async authorizeGatewayBearer(header, expected, now) {
      calls.push({ header, expected, now });
      return { grantId: "grt_aaaaaaaaaaaaaaaa" };
    },
  };
  const service = new MediaMtxExternalAuthService({ authority, now: () => 42_000 });
  await service.authorize(request());
  await service.authorize(request({ action: "read", protocol: "webrtc" }));
  await service.authorize(request({ action: "read", protocol: "hls", id: null }));

  assert.deepEqual(calls.map(({ expected }) => expected), [
    {
      action: "whip:create", path: "/broadcast/ingest/res_aaaaaaaaaaaaaaaa",
      grantKinds: ["publisher", "packager"],
    },
    {
      action: "whep:read", path: "/broadcast/play/res_aaaaaaaaaaaaaaaa",
      grantKinds: ["playback"],
    },
    {
      action: "playback:manifest", path: "/broadcast/play/res_aaaaaaaaaaaaaaaa",
      grantKinds: ["playback"],
    },
    {
      action: "playback:segment", path: "/broadcast/play/res_aaaaaaaaaaaaaaaa",
      grantKinds: ["playback"],
    },
  ]);
  assert.ok(calls.every(({ header, now }) => header === `Bearer ${TOKEN}` && now === 42_000));
});

test("MediaMTX auth rejects unknown fields, credentials, token query, path traversal and protocol confusion", async () => {
  const authority = { authorizeGatewayBearer: async () => ({}) };
  const service = new MediaMtxExternalAuthService({ authority });
  for (const candidate of [
    { ...request(), extra: true },
    request({ user: "admin" }),
    request({ password: "secret" }),
    request({ query: `token=${TOKEN}` }),
    request({ path: "../res_aaaaaaaaaaaaaaaa" }),
    request({ action: "publish", protocol: "hls" }),
    request({ protocol: "rtsp" }),
    request({ ip: "not-an-ip" }),
  ]) {
    await assert.rejects(service.authorize(candidate), errorCode(
      candidate.action === "publish" && candidate.protocol === "hls"
        ? "mediamtx_action_denied"
        : "invalid_mediamtx_auth_request",
    ));
  }
  assert.throws(() => normalizeMediaMtxAuthRequest(null), errorCode("invalid_mediamtx_auth_request"));
});

test("MediaMTX auth rate-limits by source IP and never retries a denied grant", async () => {
  let calls = 0;
  const authority = {
    async authorizeGatewayBearer() {
      calls += 1;
      return {};
    },
  };
  const service = new MediaMtxExternalAuthService({
    authority,
    now: () => 10_000,
    maximumPerWindow: 2,
    windowMs: 5_000,
  });
  await service.authorize(request());
  await service.authorize(request());
  await assert.rejects(service.authorize(request()), errorCode("mediamtx_auth_rate_limited"));
  assert.equal(calls, 2);
});
