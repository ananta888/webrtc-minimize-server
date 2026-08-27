import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig provides bounded browser-safe defaults", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.maxRoomParticipants, 4);
  assert.deepEqual(config.stunUrls, ["stun:stun.l.google.com:19302"]);
  assert.deepEqual(config.turnServers, []);
});

test("loadConfig parses TURN configuration without preserving unknown fields", () => {
  const config = loadConfig({
    PORT: "0",
    MAX_ROOM_PARTICIPANTS: "2",
    STUN_URLS: "stun:a.test, stun:b.test",
    TURN_SERVERS_JSON: JSON.stringify([{ urls: "turn:turn.test", username: "u", credential: "p", secret: "drop" }]),
  });
  assert.equal(config.port, 0);
  assert.equal(config.maxRoomParticipants, 2);
  assert.deepEqual(config.stunUrls, ["stun:a.test", "stun:b.test"]);
  assert.deepEqual(config.turnServers, [{ urls: "turn:turn.test", username: "u", credential: "p" }]);
});

test("loadConfig rejects unsafe bounds and malformed public origins", () => {
  assert.throws(() => loadConfig({ MAX_ROOM_PARTICIPANTS: "8" }), /between 2 and 4/);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "https://example.test/app" }), /without a path/);
  assert.throws(() => loadConfig({ TURN_SERVERS_JSON: "{}" }), /must be an array/);
});
