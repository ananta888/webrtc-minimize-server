import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createEdgeTurnCredentials, createTurnCredentials } from "../src/turn-credentials.js";

test("createTurnCredentials emits short-lived Coturn REST credentials without exposing principal", () => {
  const config = {
    turnUrls: ["turn:turn.test:3478?transport=udp"],
    turnSharedSecret: "test-secret",
    turnCredentialTtlMs: 600_000,
  };
  const [server] = createTurnCredentials(config, "https://issuer.test|sensitive-subject", 1_000_000);
  assert.deepEqual(server.urls, config.turnUrls);
  assert.match(server.username, /^1600:[a-f0-9]{20}$/);
  assert.doesNotMatch(server.username, /sensitive/);
  assert.equal(server.credential, crypto.createHmac("sha1", "test-secret").update(server.username).digest("base64"));
  assert.deepEqual(createTurnCredentials({ ...config, turnSharedSecret: "" }, "subject"), []);
});

test("createEdgeTurnCredentials isolates each volunteer secret and keeps it server-side", () => {
  const config = {
    edgeTurnServers: [{
      id: "edge-one",
      urls: ["turn:edge.test:3478?transport=udp"],
      sharedSecret: "edge-secret-not-returned-to-browser",
      realm: "edge.test",
    }],
    turnCredentialTtlMs: 300_000,
  };
  const [server] = createEdgeTurnCredentials(config, "issuer|subject", 1_000_000);
  assert.deepEqual(server.urls, config.edgeTurnServers[0].urls);
  assert.match(server.username, /^1300:[a-f0-9]{20}$/);
  assert.equal(
    server.credential,
    crypto.createHmac("sha1", config.edgeTurnServers[0].sharedSecret).update(server.username).digest("base64"),
  );
  assert.equal(JSON.stringify(server).includes(config.edgeTurnServers[0].sharedSecret), false);
  const [bounded] = createEdgeTurnCredentials({ ...config, turnCredentialTtlMs: 3_600_000 }, "issuer|subject", 1_000_000);
  assert.match(bounded.username, /^1600:[a-f0-9]{20}$/);
});
