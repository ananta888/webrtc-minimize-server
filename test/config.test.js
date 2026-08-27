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
