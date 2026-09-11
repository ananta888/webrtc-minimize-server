import assert from "node:assert/strict";
import test from "node:test";

import { MeetMetricsHttp } from "../src/meet-metrics-http.js";
import { MeetObservability } from "../src/meet-observability.js";
import { loadConfig } from "../src/config.js";

const origin = "https://webrtc.example";
const config = {
  authMode: "required", publicOrigin: origin, meetMetricsEnabled: true,
  oidcIssuer: "https://identity.example/realm", oidcAudience: "meet",
};
const url = new URL("/api/meet/metrics", origin);
const request = { method: "GET", headers: { authorization: "Bearer synthetic-only" } };
const operator = () => ({
  subject: "synthetic", issuer: config.oidcIssuer, audience: "meet", expiresAt: Date.now() + 60_000,
});

test("meet metrics stay default-off and require required OIDC plus HTTPS", () => {
  assert.equal(loadConfig({}).meetMetricsEnabled, false);
  assert.throws(() => loadConfig({ MEET_METRICS_ENABLED: "true" }), /required OIDC/);
});

test("operator export is closed, identity-free and disabled without the switch", async () => {
  const metrics = new MeetObservability();
  metrics.join("admitted");
  const enabled = new MeetMetricsHttp({
    config, metrics, verifier: { async verifyBroadcastOperator() { return operator(); } },
  });
  const ok = await enabled.read(request, url);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /meet_joins_total\{result="admitted"\} 1\n/);
  assert.doesNotMatch(ok.body, /synthetic|identity.example|Bearer/);
  assert.equal((await new MeetMetricsHttp({
    config: { ...config, meetMetricsEnabled: false }, metrics,
    verifier: { async verifyBroadcastOperator() { assert.fail("disabled"); } },
  }).read(request, url)).status, 404);
  assert.equal((await enabled.read({ ...request, method: "POST" }, url)).status, 404);
  enabled.destroy();
  assert.equal((await enabled.read(request, url)).status, 404);
});
