import assert from "node:assert/strict";
import test from "node:test";

import { MOQ_PROTOCOL_PINS } from "../src/moq-contracts.js";
import {
  MoqAdapterError,
  MoqAdapterRegistry,
  MoqProviderCredentialVault,
  createCloudflareMoqAdapter,
  createMediaMtxMoqAdapter,
  createTestMoqAdapter,
  validateMoqTarget,
} from "../src/moq-adapters.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programEpoch: 7,
  audienceId: "aud_cccccccccccccccc",
});
const errorCode = (code) => (error) => error instanceof MoqAdapterError && error.code === code;
const policy = Object.freeze({
  moqEnabled: true,
  requireSecureObjects: false,
  preferredCodecs: ["h264", "aac"],
  allowedFallbackProtocols: ["ll-hls", "hls"],
});

function browserCapability() {
  return {
    contractVersion: 1,
    type: "moq-capability",
    ...SCOPE,
    participantKind: "browser",
    participantRef: "brw_browserxxxxxxxxx",
    enabled: true,
    transportVersions: [MOQ_PROTOCOL_PINS.transport],
    locVersions: [MOQ_PROTOCOL_PINS.loc],
    webTransportVersions: [MOQ_PROTOCOL_PINS.webTransport],
    secureObjectVersions: [],
    codecs: ["h264", "aac"],
    fallbackProtocols: ["ll-hls", "hls"],
    extensions: ["loc-header-v04"],
    maxCatalogBytes: 65_536,
    maxObjectBytes: 1_048_576,
    observedAt: NOW,
    expiresAt: NOW + 30_000,
  };
}

test("MediaMTX and Cloudflare MoQ declare exact incompatible drafts and remain unavailable", async () => {
  const clock = () => NOW;
  const mediaMtx = createMediaMtxMoqAdapter(clock);
  const cloudflare = createCloudflareMoqAdapter(clock);
  const registry = new MoqAdapterRegistry([mediaMtx, cloudflare]);
  const inventory = registry.list(SCOPE);

  assert.deepEqual(inventory.map(({ adapterId }) => adapterId), ["cloudflare-moq", "mediamtx-moq"]);
  assert.deepEqual(mediaMtx.capability(SCOPE).transportVersions, ["draft-ietf-moq-transport-19"]);
  assert.deepEqual(cloudflare.capability(SCOPE).transportVersions, [
    "draft-ietf-moq-transport-14", "draft-ietf-moq-transport-16",
  ]);
  assert.equal(inventory.every(({ capability }) => capability.enabled === false), true);
  assert.equal(registry.negotiate({
    browserCapability: browserCapability(),
    gatewayAdapterId: "mediamtx-moq",
    providerAdapterId: "cloudflare-moq",
    policy,
    scope: SCOPE,
  }, NOW).reasonCode, "moq_capability_unavailable");
  await assert.rejects(() => mediaMtx.publish({}), errorCode("mediamtx_moq_draft_mismatch"));
  await assert.rejects(() => cloudflare.subscribe({}), errorCode("cloudflare_moq_draft_mismatch"));
  assert.notEqual(cloudflare.adapterKind, "cloudflare-stream");
});

test("registry exchanges adapters through one port without changing negotiation policy", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const calls = [];
    const transport = async (action, request) => {
      calls.push([action, request]);
      if (action === "close") return undefined;
      return {
        sessionRef: `moqs_${action.padEnd(16, "x")}`,
        endpointRef: `moqe_${action.padEnd(16, "x")}`,
        state: "active",
        expiresAt: NOW + 30_000,
        adapterId: `test-${action}`,
        transport: "moq",
        reasonCode: "test_only",
      };
    };
    const gateway = createTestMoqAdapter({
      participantKind: "gateway",
      participantRef: "gtw_gatewayxxxxxxxxx",
      adapterId: "test-gateway",
      transport,
    }, () => NOW);
    const provider = createTestMoqAdapter({
      participantKind: "provider",
      participantRef: "prv_providerxxxxxxxx",
      adapterId: "test-provider",
      transport,
    }, () => NOW);
    const registry = new MoqAdapterRegistry([gateway, provider]);
    assert.equal(registry.negotiate({
      browserCapability: browserCapability(),
      gatewayAdapterId: "test-gateway",
      providerAdapterId: "test-provider",
      policy,
      scope: SCOPE,
    }, NOW).transport, "moq");

    const opened = await registry.require("test-gateway").publish({ namespace: "opaque-to-port" });
    assert.equal(opened.sessionRef, "moqs_publishxxxxxxxxx");
    assert.equal(await registry.require("test-gateway").close(opened.sessionRef), true);
    assert.equal(await registry.require("test-gateway").close(opened.sessionRef), false);
    assert.deepEqual(calls.map(([action]) => action), ["publish", "close"]);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("provider target policy rejects SSRF shapes, path tokens and cross-host destinations", () => {
  const targetPolicy = {
    allowedHosts: ["moq.example.test"],
    allowedPathPrefixes: ["/v1/programs"],
  };
  assert.deepEqual(validateMoqTarget("https://moq.example.test/v1/programs", targetPolicy), {
    origin: "https://moq.example.test",
    pathname: "/v1/programs",
  });
  for (const [url, code] of [
    ["http://moq.example.test/v1/programs", "invalid_moq_target"],
    ["https://127.0.0.1/v1/programs", "invalid_moq_target"],
    ["https://moq.example.test/v1/programs?token=leak", "invalid_moq_target"],
    ["https://other.example.test/v1/programs", "moq_target_host_denied"],
    ["https://moq.example.test/admin", "moq_target_path_denied"],
    ["https://moq.example.test/v1/programs/%2e%2e/admin", "moq_target_path_denied"],
  ]) assert.throws(() => validateMoqTarget(url, targetPolicy), errorCode(code));
});

test("server credential vault binds tenant, environment, expiry, quota, rotation and kill switch", async () => {
  let now = NOW;
  const seenHeaders = [];
  const entry = {
    providerId: "provider-alpha",
    environment: "production",
    authorizationHeader: `Bearer ${"s".repeat(24)}`,
    allowedTenantIds: [SCOPE.tenantId],
    expiresAt: NOW + 120_000,
    maxOperationsPerMinute: 1,
    revision: 1,
    targetUrl: "https://moq.example.test/v1/programs",
    targetPolicy: { allowedHosts: ["moq.example.test"], allowedPathPrefixes: ["/v1/programs"] },
  };
  const vault = new MoqProviderCredentialVault([entry], async ({ authorizationHeader }) => {
    seenHeaders.push(authorizationHeader);
    return {
      sessionRef: "moqs_aaaaaaaaaaaaaaaa",
      endpointRef: "moqe_bbbbbbbbbbbbbbbb",
      state: "active",
      expiresAt: now + 30_000,
      adapterId: "provider-alpha",
      transport: "moq",
      reasonCode: "authorized",
    };
  }, () => now);

  const request = { providerId: "provider-alpha", tenantId: SCOPE.tenantId, environment: "production", action: "publish" };
  const result = await vault.execute(request);
  assert.equal(result.endpointRef, "moqe_bbbbbbbbbbbbbbbb");
  assert.equal(JSON.stringify(result).includes("ssss"), false);
  await assert.rejects(() => vault.execute(request), errorCode("moq_provider_rate_limited"));

  now += 60_000;
  vault.setKillSwitch("provider-alpha", true);
  await assert.rejects(() => vault.execute(request), errorCode("moq_provider_access_denied"));
  vault.setKillSwitch("provider-alpha", false);
  vault.rotate("provider-alpha", 1, { ...entry, authorizationHeader: `Bearer ${"n".repeat(24)}`, expiresAt: now + 120_000 });
  await vault.execute(request);
  assert.deepEqual(seenHeaders, [`Bearer ${"s".repeat(24)}`, `Bearer ${"n".repeat(24)}`]);
  const audit = vault.auditSnapshot();
  assert.equal(audit.some(({ outcome }) => outcome === "rate-limited"), true);
  assert.equal(audit.some(({ action }) => action === "rotate"), true);
  assert.equal(JSON.stringify(audit).includes("Bearer"), false);
  assert.equal(JSON.stringify(audit).includes("ssss"), false);
  vault.destroy();
});

test("provider consumer cannot return credentials through the adapter boundary", async () => {
  const vault = new MoqProviderCredentialVault([{
    providerId: "provider-alpha",
    environment: "staging",
    authorizationHeader: `Bearer ${"z".repeat(24)}`,
    allowedTenantIds: [SCOPE.tenantId],
    expiresAt: NOW + 60_000,
    maxOperationsPerMinute: 2,
    revision: 1,
    targetUrl: "https://moq.example.test/v1/programs",
    targetPolicy: { allowedHosts: ["moq.example.test"], allowedPathPrefixes: ["/v1/programs"] },
  }], async ({ authorizationHeader }) => ({
    sessionRef: "moqs_aaaaaaaaaaaaaaaa",
    endpointRef: "moqe_bbbbbbbbbbbbbbbb",
    state: "active",
    expiresAt: NOW + 30_000,
    authorization: authorizationHeader,
  }), () => NOW);
  await assert.rejects(() => vault.execute({
    providerId: "provider-alpha", tenantId: SCOPE.tenantId, environment: "staging", action: "subscribe",
  }), errorCode("unsafe_moq_adapter_result"));
  assert.equal(JSON.stringify(vault.auditSnapshot()).includes("zzzz"), false);
});
