import assert from "node:assert/strict";
import test from "node:test";

import { buildKeycloakClientConfig } from "../scripts/keycloak-client-config.mjs";

test("Keycloak client generator emits the exact Ananta redirect and audience defaults", () => {
  const client = buildKeycloakClientConfig({});
  assert.equal(client.clientId, "webrtc-browser");
  assert.equal(client.rootUrl, "https://webrtc.ananta.de");
  assert.deepEqual(client.redirectUris, ["https://webrtc.ananta.de/oidc-callback"]);
  assert.deepEqual(client.webOrigins, ["https://webrtc.ananta.de"]);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.equal(
    client.protocolMappers[0].config["included.custom.audience"],
    "webrtc-room-server",
  );
});

test("Keycloak client generator supports a complete operator-owned replacement", () => {
  const client = buildKeycloakClientConfig({
    PUBLIC_ORIGIN: "https://call.example.org/",
    OIDC_CLIENT_ID: "call-browser",
    OIDC_AUDIENCE: "call-server",
  });
  assert.equal(client.rootUrl, "https://call.example.org");
  assert.deepEqual(client.redirectUris, ["https://call.example.org/oidc-callback"]);
  assert.equal(client.clientId, "call-browser");
  assert.equal(client.protocolMappers[0].config["included.custom.audience"], "call-server");
  assert.throws(
    () => buildKeycloakClientConfig({ PUBLIC_ORIGIN: "https://call.example.org/path" }),
    /exact HTTP\(S\) origin/,
  );
});
