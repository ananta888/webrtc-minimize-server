import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig provides bounded browser-safe defaults", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.maxRoomParticipants, 20);
  assert.deepEqual(config.stunUrls, ["stun:stun.l.google.com:19302"]);
  assert.deepEqual(config.turnServers, []);
  assert.equal(config.authMode, "disabled");
  assert.deepEqual(config.turnUrls, []);
  assert.deepEqual(config.edgeTurnServers, []);
  assert.equal(config.peerEdgeFallbackMs, 4_000);
  assert.equal(config.infrastructureTurnFallbackMs, 9_000);
  assert.equal(config.mediaE2eeMode, "required");
  assert.equal(config.peerMediaRelayEnabled, true);
  assert.equal(config.peerRouteLeaseMs, 60_000);
  assert.equal(config.peerRouteRenewMs, 25_000);
  assert.equal(config.peerDataOverlayEnabled, true);
  assert.equal(config.pairWorkspaceEnabled, true);
  assert.equal(config.activeSpeakerLimit, 5);
  assert.deepEqual(config.mediaAgents, []);
  assert.equal(config.mediaAgentLeaseMs, 30_000);
  assert.equal(config.mediaAgentRenewMs, 10_000);
  assert.equal(config.mediaAgentShardMinParticipants, 6);
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
  assert.throws(
    () => loadConfig({ PEER_EDGE_FALLBACK_MS: "9000", INFRASTRUCTURE_TURN_FALLBACK_MS: "9000" }),
    /longer/,
  );
  assert.throws(
    () => loadConfig({ PEER_ROUTE_LEASE_MS: "30000", PEER_ROUTE_RENEW_MS: "30000" }),
    /shorter/,
  );
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
    MEDIA_AGENT_SHARD_MIN_PARTICIPANTS: "5",
  });
  assert.deepEqual(config.mediaAgents, [definition]);
  assert.equal(config.mediaAgentLeaseMs, 45_000);
  assert.equal(config.mediaAgentRenewMs, 15_000);
  assert.equal(config.mediaAgentMaxStandbys, 1);
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
