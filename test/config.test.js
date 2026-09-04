import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig provides bounded browser-safe defaults", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.maxRoomParticipants, 20);
  assert.equal(config.signalRateLimit, 300);
  assert.deepEqual(config.stunUrls, ["stun:stun.l.google.com:19302"]);
  assert.deepEqual(config.turnServers, []);
  assert.equal(config.authMode, "disabled");
  assert.deepEqual(config.turnUrls, []);
  assert.deepEqual(config.edgeTurnServers, []);
  assert.equal(config.peerEdgeFallbackMs, 4_000);
  assert.equal(config.infrastructureTurnFallbackMs, 9_000);
  assert.equal(config.mediaE2eeMode, "required");
  assert.equal(config.peerMediaRelayEnabled, true);
  assert.equal(config.peerMediaRelayMinParticipants, 3);
  assert.equal(config.peerRouteLeaseMs, 60_000);
  assert.equal(config.peerRouteRenewMs, 25_000);
  assert.equal(config.peerDataOverlayEnabled, true);
  assert.equal(config.pairWorkspaceEnabled, true);
  assert.equal(config.activeSpeakerLimit, 5);
  assert.deepEqual(config.mediaAgents, []);
  assert.equal(config.mediaAgentLeaseMs, 30_000);
  assert.equal(config.mediaAgentRenewMs, 10_000);
  assert.equal(config.mediaAgentMinParticipants, 3);
  assert.equal(config.mediaAgentShardMinParticipants, 6);
  assert.equal(config.mediaAgentRateLimit, 2_000);
  assert.equal(config.mediaAgentSelfServiceEnabled, false);
  assert.equal(config.mediaAgentEnrollmentTtlMs, 600_000);
  assert.equal(config.mediaAgentMaxPerPrincipal, 3);
  assert.equal(config.broadcastWhipEndpoint, "");
  assert.equal(config.broadcastWhipResourceBase, "");
  assert.equal(config.broadcastWhipProfile, "rfc9725");
  assert.deepEqual(config.broadcastWhipRedirectOrigins, []);
  assert.equal(config.broadcastWhipTrickleIce, true);
  assert.equal(config.broadcastWhipSimulcastEnabled, false);
  assert.deepEqual(config.broadcastWhipAudioCodecs, ["audio/opus"]);
  assert.deepEqual(config.broadcastWhipVideoCodecs, ["video/vp8", "video/h264"]);
  assert.equal(config.broadcastWhipRetryBudget, 1);
  assert.equal(config.broadcastGatewayAuthEnabled, false);
  assert.deepEqual(config.broadcastGatewayAuthAddresses, ["127.0.0.1", "::1"]);
  assert.equal(config.broadcastGatewayOrigin, "");
  assert.equal(config.broadcastSigningPrivateKey, "");
  assert.equal(config.broadcastSigningKeyId, "broadcast-control-1");
});

test("loadConfig parses TURN configuration without preserving unknown fields", () => {
  const config = loadConfig({
    PORT: "0",
    MAX_ROOM_PARTICIPANTS: "20",
    STUN_URLS: "stun:a.test, stun:b.test",
    TURN_SERVERS_JSON: JSON.stringify([{ urls: "turn:turn.test", username: "u", credential: "p", secret: "drop" }]),
  });
  assert.equal(config.port, 0);
  assert.equal(config.maxRoomParticipants, 20);
  assert.deepEqual(config.stunUrls, ["stun:a.test", "stun:b.test"]);
  assert.deepEqual(config.turnServers, [{ urls: "turn:turn.test", username: "u", credential: "p" }]);
});

test("loadConfig rejects unsafe bounds and malformed public origins", () => {
  assert.equal(loadConfig({ MAX_ROOM_PARTICIPANTS: "2" }).maxRoomParticipants, 2);
  assert.throws(() => loadConfig({ MAX_ROOM_PARTICIPANTS: "21" }), /between 2 and 20/);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "https://example.test/app" }), /without a path/);
  assert.throws(() => loadConfig({ TURN_SERVERS_JSON: "{}" }), /must be an array/);
  assert.throws(() => loadConfig({ AUTH_MODE: "required" }), /OIDC_ISSUER/);
  assert.throws(() => loadConfig({ TURN_URLS: "turn:localhost:3478" }), /configured together/);
  assert.throws(() => loadConfig({ TURN_URLS: "https://turn.test", TURN_SHARED_SECRET: "secret" }), /turn: or turns:/);
  assert.throws(() => loadConfig({ PEER_MEDIA_RELAY_ENABLED: "sometimes" }), /true or false/);
  assert.throws(() => loadConfig({ ACTIVE_SPEAKER_LIMIT: "6" }), /between 2 and 5/);
  assert.throws(() => loadConfig({ MEDIA_E2EE_MODE: "required", PEER_DATA_OVERLAY_ENABLED: "false" }), /requires/);
  assert.throws(() => loadConfig({ PEER_EDGE_FALLBACK_MS: "500" }), /between 1000 and 30000/);
  assert.throws(() => loadConfig({ MEDIA_AGENT_RATE_LIMIT: "2001" }), /between 60 and 2000/);
  assert.throws(() => loadConfig({ MEDIA_AGENT_SELF_SERVICE_ENABLED: "true" }), /requires OIDC/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_ENDPOINT: "http://media.example/live/whip" }), /HTTPS URL/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_ENDPOINT: "https://media.example/live/whip?token=secret" }), /query/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_RESOURCE_BASE: "http://media.example/ingest" }), /HTTPS URL/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_REDIRECT_ORIGINS: "https://edge.example/path" }), /HTTPS origins/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_AUDIO_CODECS: "video/vp8" }), /audio MIME/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_RETRY_BUDGET: "3" }), /between 0 and 2/);
  assert.throws(() => loadConfig({ BROADCAST_WHIP_PROFILE: "draft" }), /rfc9725 or mediamtx/);
  assert.throws(() => loadConfig({ BROADCAST_GATEWAY_AUTH_ENABLED: "sometimes" }), /true or false/);
  assert.throws(() => loadConfig({ BROADCAST_GATEWAY_AUTH_ADDRESSES: "gateway.local" }), /IP addresses/);
  assert.throws(() => loadConfig({ BROADCAST_GATEWAY_AUTH_ADDRESSES: "" }), /IP addresses/);
  assert.throws(() => loadConfig({ BROADCAST_GATEWAY_ORIGIN: "https://gateway.example/hls" }), /origin without a path/);
  assert.throws(() => loadConfig({ BROADCAST_SIGNING_KEY_ID: "bad key id" }), /URL-safe/);
  assert.throws(() => loadConfig({
    BROADCAST_WHIP_PROFILE: "mediamtx-1.20",
    BROADCAST_WHIP_SIMULCAST_ENABLED: "true",
  }), /unsupported/);
  assert.throws(
    () => loadConfig({ PEER_EDGE_FALLBACK_MS: "9000", INFRASTRUCTURE_TURN_FALLBACK_MS: "9000" }),
    /longer/,
  );
  assert.throws(
    () => loadConfig({ PEER_ROUTE_LEASE_MS: "30000", PEER_ROUTE_RENEW_MS: "30000" }),
    /shorter/,
  );
});

test("loadConfig accepts only explicit gateway callback source addresses", () => {
  const config = loadConfig({
    BROADCAST_GATEWAY_AUTH_ENABLED: "true",
    BROADCAST_GATEWAY_AUTH_ADDRESSES: "172.30.40.3,2001:db8::10,172.30.40.3",
  });
  assert.equal(config.broadcastGatewayAuthEnabled, true);
  assert.deepEqual(config.broadcastGatewayAuthAddresses, ["172.30.40.3", "2001:db8::10"]);
});

test("loadConfig accepts a bounded secret-free WHIP browser policy", () => {
  const config = loadConfig({
    BROADCAST_WHIP_ENDPOINT: "https://media.example/live/whip/",
    BROADCAST_WHIP_RESOURCE_BASE: "https://media.example/broadcast/ingest/",
    BROADCAST_WHIP_PROFILE: "rfc9725",
    BROADCAST_WHIP_REDIRECT_ORIGINS: "https://edge-a.example,https://edge-b.example",
    BROADCAST_WHIP_TRICKLE_ICE: "false",
    BROADCAST_WHIP_SIMULCAST_ENABLED: "true",
    BROADCAST_WHIP_AUDIO_CODECS: "audio/opus",
    BROADCAST_WHIP_VIDEO_CODECS: "video/h264,video/vp8",
    BROADCAST_WHIP_REQUEST_TIMEOUT_MS: "5000",
    BROADCAST_WHIP_ICE_GATHERING_TIMEOUT_MS: "6000",
    BROADCAST_WHIP_CONNECTION_TIMEOUT_MS: "12000",
    BROADCAST_WHIP_RETRY_BUDGET: "2",
  });
  assert.equal(config.broadcastWhipEndpoint, "https://media.example/live/whip");
  assert.equal(config.broadcastWhipResourceBase, "https://media.example/broadcast/ingest");
  assert.equal(config.broadcastWhipProfile, "rfc9725");
  assert.deepEqual(config.broadcastWhipRedirectOrigins, ["https://edge-a.example", "https://edge-b.example"]);
  assert.equal(config.broadcastWhipTrickleIce, false);
  assert.deepEqual(config.broadcastWhipVideoCodecs, ["video/h264", "video/vp8"]);
  assert.equal(config.broadcastWhipRequestTimeoutMs, 5_000);
  assert.equal(config.broadcastWhipIceGatheringTimeoutMs, 6_000);
  assert.equal(config.broadcastWhipConnectionTimeoutMs, 12_000);
  assert.equal(config.broadcastWhipRetryBudget, 2);
  assert.equal(config.broadcastWhipSimulcastEnabled, true);
  assert.equal(Object.hasOwn(config, "broadcastWhipToken"), false);
});

test("loadConfig accepts closed volunteer Edge-TURN definitions", () => {
  const config = loadConfig({
    EDGE_TURN_SERVERS_JSON: JSON.stringify([{
      id: "friend-edge-1",
      urls: ["turn:edge.example:3478?transport=udp", "turn:edge.example:3478?transport=tcp"],
      sharedSecret: "0123456789abcdef0123456789abcdef",
      realm: "webrtc.example",
    }]),
    PEER_EDGE_FALLBACK_MS: "3000",
    INFRASTRUCTURE_TURN_FALLBACK_MS: "8000",
  });
  assert.equal(config.edgeTurnServers.length, 1);
  assert.equal(config.edgeTurnServers[0].id, "friend-edge-1");
  assert.equal(config.peerEdgeFallbackMs, 3_000);
  assert.equal(config.infrastructureTurnFallbackMs, 8_000);
  assert.throws(() => loadConfig({
    EDGE_TURN_SERVERS_JSON: JSON.stringify([{
      id: "EDGE",
      urls: ["stun:not-edge.example"],
      sharedSecret: "short",
      realm: "bad realm",
      extra: true,
    }]),
  }), /invalid entry or field/);
});

test("loadConfig accepts only closed operator-bound blind media agents", () => {
  const definition = {
    id: "laptop-edge",
    ownerPrincipal: "https://identity.example/realms/ananta|user-123",
    sharedSecret: "0123456789abcdef0123456789abcdef",
  };
  const config = loadConfig({
    MEDIA_EDGE_AGENTS_JSON: JSON.stringify([definition]),
    MEDIA_AGENT_LEASE_MS: "45000",
    MEDIA_AGENT_RENEW_MS: "15000",
    MEDIA_AGENT_MAX_STANDBYS: "1",
    MEDIA_AGENT_MIN_PARTICIPANTS: "4",
    MEDIA_AGENT_SHARD_MIN_PARTICIPANTS: "5",
  });
  assert.deepEqual(config.mediaAgents, [definition]);
  assert.equal(config.mediaAgentLeaseMs, 45_000);
  assert.equal(config.mediaAgentRenewMs, 15_000);
  assert.equal(config.mediaAgentMaxStandbys, 1);
  assert.equal(config.mediaAgentMinParticipants, 4);
  assert.equal(config.mediaAgentShardMinParticipants, 5);
  assert.throws(() => loadConfig({
    MEDIA_EDGE_AGENTS_JSON: JSON.stringify([{ ...definition, sharedSecret: "short" }]),
  }), /32-512/);
  assert.throws(() => loadConfig({
    MEDIA_EDGE_AGENTS_JSON: JSON.stringify([{ ...definition, authority: "room-owner" }]),
  }), /exactly/);
  assert.throws(() => loadConfig({
    MEDIA_AGENT_LEASE_MS: "15000", MEDIA_AGENT_RENEW_MS: "15000",
  }), /shorter/);
  assert.throws(() => loadConfig({ MEDIA_AGENT_SHARD_MIN_PARTICIPANTS: "2" }), /between 3 and 20/);
  assert.throws(() => loadConfig({ MEDIA_AGENT_MIN_PARTICIPANTS: "2" }), /between 3 and 20/);
});

test("loadConfig accepts explicit OIDC and ephemeral TURN settings", () => {
  const config = loadConfig({
    AUTH_MODE: "required",
    OIDC_ISSUER: "https://identity.example/realms/webrtc/",
    OIDC_AUDIENCE: "rooms",
    OIDC_CLIENT_ID: "browser",
    OIDC_JWKS_URL: "http://keycloak:8080/certs",
    TURN_URLS: "turn:turn.example:3478?transport=udp, turns:turn.example:5349",
    TURN_SHARED_SECRET: "test-only-secret",
  });
  assert.equal(config.oidcIssuer, "https://identity.example/realms/webrtc");
  assert.equal(config.oidcJwksUrl, "http://keycloak:8080/certs");
  assert.deepEqual(config.turnUrls, [
    "turn:turn.example:3478?transport=udp", "turns:turn.example:5349",
  ]);
});

test("loadConfig reads production secrets from bounded files without ambiguous fallback", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "webrtc-secrets-"));
  const turnFile = path.join(directory, "turn");
  const edgeFile = path.join(directory, "edge-turn.json");
  const agentsFile = path.join(directory, "agents.json");
  writeFileSync(turnFile, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
  writeFileSync(edgeFile, JSON.stringify([{
    id: "minipc",
    urls: ["turn:minipc.example:3478?transport=udp"],
    sharedSecret: "abcdef0123456789abcdef0123456789",
    realm: "webrtc.example",
  }]), { mode: 0o600 });
  writeFileSync(agentsFile, JSON.stringify([{
    id: "minipc",
    ownerPrincipal: "https://identity.example/realms/ananta|owner",
    sharedSecret: "abcdef0123456789abcdef0123456789",
  }]), { mode: 0o600 });

  const config = loadConfig({
    TURN_URLS: "turn:turn.example:3478?transport=udp",
    TURN_SHARED_SECRET_FILE: turnFile,
    EDGE_TURN_SERVERS_JSON_FILE: edgeFile,
    MEDIA_EDGE_AGENTS_JSON_FILE: agentsFile,
  });
  assert.equal(config.turnSharedSecret, "0123456789abcdef0123456789abcdef");
  assert.equal(config.edgeTurnServers[0].id, "minipc");
  assert.equal(config.mediaAgents[0].id, "minipc");
  assert.throws(() => loadConfig({
    TURN_URLS: "turn:turn.example:3478",
    TURN_SHARED_SECRET: "direct",
    TURN_SHARED_SECRET_FILE: turnFile,
  }), /cannot be configured together/);
  assert.throws(() => loadConfig({
    TURN_URLS: "turn:turn.example:3478",
    TURN_SHARED_SECRET_FILE: path.join(directory, "missing"),
  }), /cannot be read/);
});

test("loadConfig enables bounded HTTPS media-agent self service explicitly", () => {
  const config = loadConfig({
    PUBLIC_ORIGIN: "https://webrtc.example",
    AUTH_MODE: "required",
    OIDC_ISSUER: "https://identity.example/realms/webrtc",
    OIDC_AUDIENCE: "rooms",
    OIDC_CLIENT_ID: "browser",
    MEDIA_AGENT_SELF_SERVICE_ENABLED: "true",
    MEDIA_AGENT_ENROLLMENT_TTL_MS: "300000",
    MEDIA_AGENT_MAX_PER_PRINCIPAL: "2",
    MEDIA_AGENT_ENROLLMENT_RATE_LIMIT: "4",
  });
  assert.equal(config.mediaAgentSelfServiceEnabled, true);
  assert.equal(config.mediaAgentEnrollmentTtlMs, 300_000);
  assert.equal(config.mediaAgentMaxPerPrincipal, 2);
  assert.equal(config.mediaAgentEnrollmentRateLimit, 4);
  assert.throws(() => loadConfig({
    PUBLIC_ORIGIN: "http://webrtc.example",
    AUTH_MODE: "required",
    OIDC_ISSUER: "https://identity.example/realms/webrtc",
    OIDC_AUDIENCE: "rooms",
    OIDC_CLIENT_ID: "browser",
    MEDIA_AGENT_SELF_SERVICE_ENABLED: "true",
  }), /HTTPS PUBLIC_ORIGIN/);
});

test("loadConfig derives a replaceable issuer from Keycloak origin and realm", () => {
  const config = loadConfig({
    AUTH_MODE: "required",
    PUBLIC_ORIGIN: "https://webrtc.ananta.de",
    KEYCLOAK_ORIGIN: "https://keycloak.ananta.de/",
    KEYCLOAK_REALM: "ananta",
  });
  assert.equal(config.publicOrigin, "https://webrtc.ananta.de");
  assert.equal(config.oidcIssuer, "https://keycloak.ananta.de/realms/ananta");
  assert.equal(
    config.oidcJwksUrl,
    "https://keycloak.ananta.de/realms/ananta/protocol/openid-connect/certs",
  );
  assert.equal(config.oidcClientId, "webrtc-browser");
  assert.equal(config.oidcAudience, "webrtc-room-server");
});

test("loadConfig rejects ambiguous or unsafe Keycloak shortcuts", () => {
  assert.throws(
    () => loadConfig({ KEYCLOAK_ORIGIN: "https://identity.example" }),
    /must be configured together/,
  );
  assert.throws(
    () => loadConfig({ KEYCLOAK_REALM: "custom" }),
    /must be configured together/,
  );
  assert.throws(
    () => loadConfig({ KEYCLOAK_ORIGIN: "https://identity.example/auth", KEYCLOAK_REALM: "custom" }),
    /without a path/,
  );
  assert.throws(
    () => loadConfig({ KEYCLOAK_ORIGIN: "https://identity.example", KEYCLOAK_REALM: "../master" }),
    /only letters/,
  );
});
