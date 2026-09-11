import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { BroadcastMetricsHttp } from "../src/broadcast-metrics-http.js";
import { BroadcastHlsProxy } from "../src/broadcast-hls-proxy.js";
import { createOidcVerifier } from "../src/oidc-verifier.js";
import { createAppServer } from "../src/server.js";
import { BROADCAST_PROGRAM_STATES } from "../src/broadcast-program-model.js";
import { loadConfig } from "../src/config.js";

const origin = "https://webrtc.example", issuer = "https://identity.example/realm";
const config = { authMode: "required", publicOrigin: origin, broadcastMetricsEnabled: true,
  oidcIssuer: issuer, oidcAudience: "meet", oidcAlgorithms: ["EdDSA"], oidcJwksUrl: `${issuer}/certs`,
  pairWorkspaceEnabled: false };
const path = "/api/broadcasts/metrics", url = new URL(path, origin);
const request = { method: "GET", headers: { authorization: "Bearer synthetic-only" } };
const operator = () => ({ subject: "synthetic", issuer, audience: "meet", expiresAt: Date.now() + 60_000 });

async function signedFixture() {
  const keys = await generateKeyPair("EdDSA", { extractable: true });
  const verifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }) });
  const token = (payload = { realm_access: { roles: ["broadcast-operator"] } }, options = {}) =>
    new SignJWT(payload).setProtectedHeader({ alg: "EdDSA" }).setIssuer(options.issuer || issuer)
      .setAudience(options.audience || "meet").setSubject("private-operator-subject")
      .setIssuedAt().setExpirationTime(options.expiresAt ?? "1m").sign(options.key || keys.privateKey);
  return { verifier, token };
}

test("operator export configuration is explicit, required-OIDC and HTTPS only", () => {
  assert.equal(loadConfig({}).broadcastMetricsEnabled, false);
  assert.throws(() => loadConfig({ BROADCAST_METRICS_ENABLED: "sometimes" }), /true or false/);
  assert.throws(() => loadConfig({ BROADCAST_METRICS_ENABLED: "true" }), /required OIDC/);
  const env = { BROADCAST_METRICS_ENABLED: "true", AUTH_MODE: "required", PUBLIC_ORIGIN: origin,
    KEYCLOAK_ORIGIN: "https://identity.example", KEYCLOAK_REALM: "realm" };
  assert.equal(loadConfig(env).broadcastMetricsEnabled, true);
  assert.throws(() => loadConfig({ ...env, PUBLIC_ORIGIN: "http://webrtc.example" }), /HTTPS/);
});

test("only a signed exact realm operator role passes without changing human identities", async () => {
  const f = await signedFixture();
  const valid = await f.token();
  assert.deepEqual(await f.verifier.verifyBroadcastOperator(valid), await f.verifier.verify(valid));
  for (const payload of [{}, { roles: ["broadcast-operator"] }, { scope: "broadcast-operator" },
    { realm_access: { roles: "broadcast-operator" } }, { realm_access: { roles: ["admin", "Broadcast-Operator"] } },
    { resource_access: { meet: { roles: ["broadcast-operator"] } } },
    { realm_access: { roles: ["broadcast-operator", {}] } },
    { realm_access: { roles: Array(257).fill("broadcast-operator") } }]) {
    await assert.rejects(f.verifier.verifyBroadcastOperator(await f.token(payload)), /broadcast_operator_required/);
  }
  await assert.rejects(createOidcVerifier({ authMode: "disabled" }).verifyBroadcastOperator(valid), /authentication_disabled/);
});

test("actual HTTP endpoint rejects ordinary or invalid JWTs and exports only fixed counts", async t => {
  const f = await signedFixture();
  const proxy = new BroadcastHlsProxy({ gatewayOrigin: "https://gateway.example", sessions: {
    create() {}, renew() {}, authorize: async () => ({ sessionId: "private-session-canary", upstreamPath: "/private-path-canary",
      budgetScope: { tenantId: "tn_aaaaaaaaaaaaaaaa", audienceRef: "sub_aaaaaaaaaaaaaaaa" } }),
  }, fetchImpl: async () => new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }) });
  await new Response((await proxy.fetchMedia({ method: "GET" })).body).arrayBuffer();
  const app = createAppServer({ config: { ...config, broadcastNativeResourceLimits: { encoderSlots: 0, cpuUnits: 123 } },
    oidcVerifier: f.verifier, broadcastHlsProxy: proxy,
    broadcastRuntime: { programStateCounts: () => Object.fromEntries(BROADCAST_PROGRAM_STATES.map(state => [state, state === "live" ? 2 : 0])) } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { app.server.closeAllConnections(); return new Promise(resolve => app.server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${app.server.address().port}${path}`;
  const valid = await f.token();
  const get = (token, options = {}) => fetch(endpoint + (options.query || ""), {
    method: options.method || "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const response = await get(valid);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Authorization, Origin");
  assert.match(response.headers.get("content-type"), /^text\/plain; version=0.0.4/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const text = await response.text();
  assert.match(text, /broadcast_control_programs\{state="live"\} 2/);
  assert.equal(text.trim().split("\n").length, 25);
  assert.match(text, /broadcast_native_planning_encoder_slots\{kind="limit"\} 0\n/);
  assert.match(text, /broadcast_native_planning_cpu_units\{kind="limit"\} 123\n/);
  assert.match(text, /broadcast_native_planning_cpu_units\{kind="reserved"\} 0\n/);
  assert.match(text, /broadcast_hls_proxy_body_bytes_total 4\n/);
  assert.match(text, /broadcast_hls_proxy_requests_total\{outcome="completed"\} 1\n/);
  assert.doesNotMatch(text, /private-session|private-path|gateway\.example/);
  assert.doesNotMatch(text, /private-operator|Bearer|identity\.example|room|tenant|caption|frames|bitrate/);
  assert.equal((await get()).status, 401);
  assert.equal((await get(await f.token({}))).status, 403);
  assert.equal((await get("invalid-token")).status, 401);
  for (const options of [{ issuer: "https://other.example" }, { audience: "other" }, { expiresAt: 1 },
    { key: (await generateKeyPair("EdDSA")).privateKey }]) {
    assert.equal((await get(await f.token(undefined, options))).status, 401);
  }
  const disallowedAlgorithm = await new SignJWT({ realm_access: { roles: ["broadcast-operator"] } })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience("meet")
    .setSubject("synthetic-only").setExpirationTime("1m").sign(new Uint8Array(32).fill(7));
  assert.equal((await get(disallowedAlgorithm)).status, 401);
  for (const options of [{ query: "?token=synthetic" }, { headers: { origin: "https://foreign.example" } },
    { method: "POST" }, { method: "HEAD" }]) assert.equal((await get(valid, options)).status, 404);
  assert.equal((await get(valid, { headers: { origin } })).status, 200);
  assert.equal((await fetch(endpoint, { headers: { cookie: `token=${valid}` } })).status, 401);
});

test("missing required signed claims and unavailable JWKS fail closed", async () => {
  const keys = await generateKeyPair("EdDSA", { extractable: true });
  const jwks = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
  const verifier = createOidcVerifier(config, { jwks });
  const claims = { iss: issuer, aud: "meet", sub: "synthetic-only", exp: Math.floor(Date.now() / 1000) + 60,
    realm_access: { roles: ["broadcast-operator"] } };
  for (const field of ["iss", "aud", "sub", "exp"]) {
    const payload = { ...claims }; delete payload[field];
    const token = await new SignJWT(payload).setProtectedHeader({ alg: "EdDSA" }).sign(keys.privateKey);
    await assert.rejects(verifier.verifyBroadcastOperator(token), /invalid_access_token/);
  }
  const token = await new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).sign(keys.privateKey);
  const unavailable = createOidcVerifier(config, { jwks: async () => { throw new Error("private-upstream-canary"); } });
  await assert.rejects(unavailable.verifyBroadcastOperator(token), { message: "invalid_access_token" });
});

test("rejected requests release inflight slots without leaking verifier errors", async () => {
  let calls = 0;
  const gate = new BroadcastMetricsHttp({ config, metrics: { prometheus: () => "count 0\n" },
    verifier: { async verifyBroadcastOperator() { calls++; throw new Error("private-upstream-canary"); } } });
  for (let n = 0; n < 4; n++) {
    const response = await gate.read(request, url);
    assert.equal(response.status, 503);
    assert.equal(response.body, "broadcast_metrics_unavailable\n");
  }
  assert.equal(calls, 4);
  assert.equal((await gate.read({ ...request, headers: { authorization: "x".repeat(8193) } }, url)).status, 401);
  assert.equal(calls, 4);
  const expired = new BroadcastMetricsHttp({ config, metrics: { prometheus() { assert.fail("unauthorized sample"); } },
    verifier: { async verifyBroadcastOperator() { return { ...operator(), expiresAt: Date.now() - 1 }; } } });
  assert.equal((await expired.read(request, url)).status, 401);
});

test("disabled, missing verifier or unavailable samples never export data", async () => {
  let calls = 0;
  const args = { config, verifier: { async verifyBroadcastOperator() { calls++; return operator(); } },
    metrics: { prometheus: () => "count 0\n" } };
  for (const changes of [{ broadcastMetricsEnabled: false }, { authMode: "disabled" }, { publicOrigin: "http://webrtc.example" }]) {
    assert.equal((await new BroadcastMetricsHttp({ ...args, config: { ...config, ...changes } }).read(request, url)).status, 404);
  }
  assert.equal(calls, 0);
  assert.equal((await new BroadcastMetricsHttp({ ...args, verifier: {} }).read(request, url)).status, 503);
  assert.equal((await new BroadcastMetricsHttp({ ...args, metrics: { prometheus: () => "" } }).read(request, url)).status, 503);
  assert.equal((await new BroadcastMetricsHttp({ ...args, verifier: { async verifyBroadcastOperator() { return false; } } }).read(request, url)).status, 401);
});

test("fixed request/inflight budgets, rollback and shutdown cannot create identity state or bypass auth", async () => {
  let now = 0, calls = 0;
  const metrics = { prometheus: () => "count 0\n" };
  const gate = new BroadcastMetricsHttp({ config, metrics, clock: () => now,
    verifier: { async verifyBroadcastOperator() { calls++; return operator(); } } });
  for (let n = 0; n < 60; n++) assert.equal((await gate.read(request, url)).status, 200);
  assert.equal((await gate.read(request, url)).status, 429);
  assert.equal(calls, 60);
  now = 60_000; assert.equal((await gate.read(request, url)).status, 200);
  now--; assert.equal((await gate.read(request, url)).status, 429);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const inflight = new BroadcastMetricsHttp({ config, metrics,
    verifier: { async verifyBroadcastOperator() { await pending; return operator(); } } });
  const first = inflight.read(request, url), second = inflight.read(request, url);
  assert.equal((await inflight.read(request, url)).status, 429);
  inflight.destroy(); release();
  assert.equal((await first).status, 503);
  assert.equal((await second).status, 503);
  assert.equal((await inflight.read(request, url)).status, 404);
});
