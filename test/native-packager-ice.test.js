import assert from "node:assert/strict";
import test from "node:test";

import { createNativePackagerIceServers } from "../src/native-packager-ice.js";

test("native packager ICE is scoped to the agent and excludes static TURN credentials", () => {
  const config = {
    stunUrls: ["stun:stun.example.test:3478"],
    edgeTurnServers: [{
      urls: ["turn:edge.example.test:3478"], sharedSecret: "e".repeat(32), realm: "example.test",
    }],
    turnUrls: ["turns:turn.example.test:5349"],
    turnSharedSecret: "i".repeat(32),
    turnCredentialTtlMs: 300_000,
    turnServers: [{ urls: "turn:static.example.test:3478", username: "static", credential: "forbidden" }],
  };
  const now = 1_800_000_000_000;
  const servers = createNativePackagerIceServers(config, "pkr_aaaaaaaaaaaaaaaa", now);
  assert.equal(servers.length, 3);
  assert.deepEqual(servers[0], { urls: ["stun:stun.example.test:3478"] });
  assert.equal(servers.some((server) => server.urls.includes("turn:static.example.test:3478")), false);
  for (const server of servers.slice(1)) {
    assert.match(server.username, /^1800000\d{3}:[a-f0-9]{20}$/);
    assert.equal(server.credentialType, "password");
    assert.ok(server.credential.length >= 20);
  }
  assert.ok(Object.isFrozen(servers));
  assert.ok(servers.every((server) => Object.isFrozen(server) && Object.isFrozen(server.urls)));
});
