import assert from "node:assert/strict";
import test from "node:test";

import { createMediaAgentIceServers } from "../src/media-agent-ice.js";

test("native media-agent ICE leases encode every URL as a Pion-compatible array", () => {
  const servers = createMediaAgentIceServers({
    stunUrls: ["stun:stun.example:3478"],
    edgeTurnServers: [{
      id: "edge-one",
      urls: ["turn:edge.example:3478?transport=udp", "turn:edge.example:3478?transport=tcp"],
      sharedSecret: "e".repeat(32),
      realm: "webrtc.example",
    }],
    turnServers: [{ urls: "turn:static.example:3478", username: "static", credential: "credential" }],
    turnUrls: ["turn:infra.example:3478?transport=udp"],
    turnSharedSecret: "i".repeat(32),
    turnCredentialTtlMs: 300_000,
  }, "edge-0123456789abcdef", 1_700_000_000_000);

  assert.equal(servers.length, 4);
  assert.deepEqual(servers.map(({ urls }) => urls), [
    ["stun:stun.example:3478"],
    ["turn:edge.example:3478?transport=udp", "turn:edge.example:3478?transport=tcp"],
    ["turn:static.example:3478"],
    ["turn:infra.example:3478?transport=udp"],
  ]);
  assert.ok(servers.every(({ urls }) => Array.isArray(urls) && urls.length > 0));
  assert.equal(servers[0].username, undefined);
  assert.equal(servers[1].credentialType, "password");
  assert.equal(servers[2].credentialType, undefined);
  assert.equal(servers[3].credentialType, "password");
  assert.match(JSON.stringify(servers), /"urls":\["stun:stun\.example:3478"\]/);
  assert.doesNotMatch(JSON.stringify(servers), /edge-0123456789abcdef/);
});
