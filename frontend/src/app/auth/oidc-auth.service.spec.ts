import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildAuthorizationUrl } from "./oidc-auth.service";

const request = {
  clientId: "webrtc-browser",
  redirectUri: "https://webrtc.ananta.de/oidc-callback",
  challenge: "pkce-challenge",
  state: "state-value",
  nonce: "nonce-value",
};

describe("OIDC authorization entry", () => {
  it("builds the existing login request as Authorization Code with PKCE", () => {
    const url = new URL(buildAuthorizationUrl(
      "https://keycloak.ananta.de/realms/ananta/protocol/openid-connect/auth",
      request,
    ));

    expect(url.searchParams.get("client_id")).toBe("webrtc-browser");
    expect(url.searchParams.get("redirect_uri")).toBe(request.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(request.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("nonce")).toBe(request.nonce);
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("requests account creation without changing the protected callback flow", () => {
    const url = new URL(buildAuthorizationUrl(
      "https://keycloak.ananta.de/realms/ananta/protocol/openid-connect/auth",
      request,
      "register",
    ));

    expect(url.searchParams.get("prompt")).toBe("create");
    expect(url.searchParams.get("redirect_uri")).toBe(request.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(url.searchParams.has("id_token")).toBe(false);
  });

  it("exposes separate login and registration actions on the room page", () => {
    const template = readFileSync(
      "frontend/src/app/features/room/room-page.component.html",
      "utf8",
    );

    expect(template).toContain('id="login"');
    expect(template).toContain('(click)="auth.login()"');
    expect(template).toContain('id="register"');
    expect(template).toContain('(click)="auth.register()"');
  });
});
