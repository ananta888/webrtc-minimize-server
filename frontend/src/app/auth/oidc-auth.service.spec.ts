import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAuthorizationUrl, OidcAuthService } from "./oidc-auth.service";
import { RuntimeConfig } from "../core/runtime-config.service";

const request = {
  clientId: "webrtc-browser",
  redirectUri: "https://webrtc.ananta.de/oidc-callback",
  challenge: "pkce-challenge",
  state: "state-value",
  nonce: "nonce-value",
};

describe("OIDC authorization entry", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
  const config = (mode = "required") => ({ auth: { mode, issuer: "https://identity.example/realms/test",
    clientId: "browser", audience: "server" } }) as RuntimeConfig;

  it("keeps unconfigured and disabled entry closed without rejected promises, requests or PKCE state", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const auth = new OidcAuthService();
    expect(auth.authorizationReady()).toBe(false);
    await expect(auth.login()).resolves.toBeUndefined();
    expect(auth.error()).toBe("oidc_configuration_missing");
    expect(auth.busy()).toBe(false);
    auth.configure(config("disabled"));
    await expect(auth.register()).resolves.toBeUndefined();
    expect(auth.authorizationReady()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("webrtc.oidc.pkce")).toBeNull();
  });

  it("serializes entry and rejects reconfiguration before storing a PKCE transaction", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const auth = new OidcAuthService(); auth.configure(config());
    expect(auth.authorizationReady()).toBe(true);
    const first = auth.login();
    await auth.register();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(auth.busy()).toBe(true);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", signal: expect.any(AbortSignal) });
    auth.configure(config("disabled"));
    release(new Response(JSON.stringify({ issuer: config().auth.issuer,
      authorization_endpoint: "https://identity.example/auth", token_endpoint: "https://identity.example/token" })));
    await first;
    expect(auth.busy()).toBe(false);
    expect(auth.error()).toBe("oidc_configuration_missing");
    expect(sessionStorage.getItem("webrtc.oidc.pkce")).toBeNull();
  });

  it("does not consume a discovery body delivered after the bounded request expired", async () => {
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const auth = new OidcAuthService(); auth.configure(config());
    const pending = auth.login();
    abort.abort();
    release(new Response(JSON.stringify({ issuer: config().auth.issuer,
      authorization_endpoint: "https://identity.example/auth", token_endpoint: "https://identity.example/token" })));
    await pending;
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(auth.error()).toBe("oidc_login_failed");
    expect(auth.busy()).toBe(false);
    expect(sessionStorage.getItem("webrtc.oidc.pkce")).toBeNull();
  });
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
