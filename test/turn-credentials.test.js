import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createTurnCredentials } from "../src/turn-credentials.js";

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
