import { Injectable, computed, signal } from "@angular/core";

import { RuntimeConfig } from "../core/runtime-config.service";

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface PkceTransaction {
  verifier: string;
  state: string;
  nonce: string;
  returnUrl: string;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
}

const TOKEN_KEY = "webrtc.oidc.access-token";
const ID_TOKEN_KEY = "webrtc.oidc.id-token";
const REFRESH_TOKEN_KEY = "webrtc.oidc.refresh-token";
const PKCE_KEY = "webrtc.oidc.pkce";

function randomBase64Url(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch {
    return null;
  }
}

function audienceMatches(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

@Injectable({ providedIn: "root" })
export class OidcAuthService {
  readonly accessToken = signal<string | null>(sessionStorage.getItem(TOKEN_KEY));
  readonly idToken = signal<string | null>(sessionStorage.getItem(ID_TOKEN_KEY));
  readonly busy = signal(false);
  readonly error = signal("");
  readonly claims = computed(() => this.accessToken() ? decodeJwt(this.accessToken()!) : null);
  readonly authenticated = computed(() => {
    const claims = this.claims();
    const expiry = Number(claims?.["exp"] || 0) * 1000;
    return Boolean(claims?.["sub"] && expiry > Date.now());
  });
  readonly username = computed(() => {
    const claims = this.claims();
    return String(claims?.["preferred_username"] || claims?.["name"] || claims?.["email"] || "");
  });
  private config: RuntimeConfig | null = null;
  private metadata: OidcMetadata | null = null;
  private expiryHandle: ReturnType<typeof setTimeout> | null = null;

  configure(config: RuntimeConfig): void {
    this.config = config;
    const claims = this.claims();
    if (
      config.auth.mode === "disabled"
      || !this.authenticated()
      || claims?.["iss"] !== config.auth.issuer
      || !audienceMatches(claims?.["aud"], config.auth.audience)
    ) this.clearTokens();
    else if (this.accessToken()) this.scheduleTokenRenewal(this.accessToken()!);
  }

  authorizationHeader(): Record<string, string> {
    const token = this.accessToken();
    const expiry = Number(decodeJwt(token || "")?.["exp"] || 0) * 1000;
    if (!token || expiry <= Date.now()) {
      this.clearTokens();
      return {};
    }
    return { Authorization: `Bearer ${token}` };
  }

  async login(returnUrl = "/"): Promise<void> {
    const auth = this.requireAuthConfig();
    this.busy.set(true);
    this.error.set("");
    try {
      const metadata = await this.loadMetadata(auth.issuer);
      const verifier = randomBase64Url(48);
      const state = randomBase64Url(24);
      const nonce = randomBase64Url(24);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const transaction: PkceTransaction = {
        verifier, state, nonce, returnUrl, issuer: auth.issuer,
        clientId: auth.clientId, tokenEndpoint: metadata.token_endpoint,
      };
      sessionStorage.setItem(PKCE_KEY, JSON.stringify(transaction));
      const params = new URLSearchParams({
        client_id: auth.clientId,
        redirect_uri: `${location.origin}/oidc-callback`,
        response_type: "code",
        scope: "openid profile email",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });
      location.assign(`${metadata.authorization_endpoint}?${params}`);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "oidc_login_failed");
      this.busy.set(false);
    }
  }

  async handleCallback(search = location.search): Promise<string> {
    const transaction = this.readTransaction();
    const params = new URLSearchParams(search);
    if (params.get("error")) throw new Error("authorization_denied");
    const code = params.get("code");
    if (!code || params.get("state") !== transaction.state) throw new Error("oidc_callback_invalid");
    sessionStorage.removeItem(PKCE_KEY);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: transaction.clientId,
      code,
      redirect_uri: `${location.origin}/oidc-callback`,
      code_verifier: transaction.verifier,
    });
    const response = await fetch(transaction.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error("token_exchange_failed");
    const tokens = await response.json() as { access_token?: string; id_token?: string; refresh_token?: string };
    if (!tokens.access_token || !tokens.id_token) throw new Error("token_response_invalid");
    const accessClaims = decodeJwt(tokens.access_token);
    const idClaims = decodeJwt(tokens.id_token);
    if (
      accessClaims?.["iss"] !== transaction.issuer
      || !audienceMatches(accessClaims?.["aud"], this.requireAuthConfig().audience)
      || Number(accessClaims?.["exp"] || 0) * 1000 <= Date.now()
      || idClaims?.["nonce"] !== transaction.nonce
    ) throw new Error("token_claims_invalid");
    sessionStorage.setItem(TOKEN_KEY, tokens.access_token);
    sessionStorage.setItem(ID_TOKEN_KEY, tokens.id_token);
    if (tokens.refresh_token) sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
    this.accessToken.set(tokens.access_token);
    this.idToken.set(tokens.id_token);
    this.scheduleTokenRenewal(tokens.access_token);
    return transaction.returnUrl || "/";
  }

  async logout(): Promise<void> {
    const idToken = this.idToken();
    const issuer = this.config?.auth.issuer;
    this.clearTokens();
    if (!issuer) return;
    try {
      const metadata = await this.loadMetadata(issuer);
      if (!metadata.end_session_endpoint) return;
      const params = new URLSearchParams({ post_logout_redirect_uri: location.origin });
      if (idToken) params.set("id_token_hint", idToken);
      location.assign(`${metadata.end_session_endpoint}?${params}`);
    } catch {
      location.assign("/");
    }
  }

  private clearTokens(): void {
    if (this.expiryHandle) clearTimeout(this.expiryHandle);
    this.expiryHandle = null;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(ID_TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    this.accessToken.set(null);
    this.idToken.set(null);
  }

  private scheduleTokenRenewal(token: string): void {
    if (this.expiryHandle) clearTimeout(this.expiryHandle);
    const expiresAt = Number(decodeJwt(token)?.["exp"] || 0) * 1000;
    const delay = Math.max(0, Math.min(expiresAt - Date.now() - 30_000, 2_147_483_647));
    this.expiryHandle = setTimeout(() => { void this.refreshTokens(); }, delay);
  }

  private async refreshTokens(): Promise<void> {
    const refreshToken = sessionStorage.getItem(REFRESH_TOKEN_KEY);
    const auth = this.config?.auth;
    if (!refreshToken || !auth?.issuer || !auth.clientId) {
      this.clearTokens();
      return;
    }
    try {
      const metadata = await this.loadMetadata(auth.issuer);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.clientId,
        refresh_token: refreshToken,
      });
      const response = await fetch(metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) throw new Error("token_refresh_failed");
      const tokens = await response.json() as { access_token?: string; id_token?: string; refresh_token?: string };
      const claims = decodeJwt(tokens.access_token || "");
      if (
        !tokens.access_token
        || claims?.["iss"] !== auth.issuer
        || !audienceMatches(claims?.["aud"], auth.audience)
        || Number(claims?.["exp"] || 0) * 1000 <= Date.now()
      ) throw new Error("refreshed_token_invalid");
      sessionStorage.setItem(TOKEN_KEY, tokens.access_token);
      if (tokens.id_token) sessionStorage.setItem(ID_TOKEN_KEY, tokens.id_token);
      if (tokens.refresh_token) sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
      this.accessToken.set(tokens.access_token);
      if (tokens.id_token) this.idToken.set(tokens.id_token);
      this.scheduleTokenRenewal(tokens.access_token);
    } catch {
      this.clearTokens();
      this.error.set("token_refresh_failed");
    }
  }

  private requireAuthConfig() {
    const auth = this.config?.auth;
    if (!auth?.issuer || !auth.clientId) throw new Error("oidc_configuration_missing");
    return auth;
  }

  private readTransaction(): PkceTransaction {
    try {
      const value = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null") as PkceTransaction | null;
      if (!value?.verifier || !value.state || !value.nonce) throw new Error();
      return value;
    } catch {
      throw new Error("oidc_transaction_missing");
    }
  }

  private async loadMetadata(issuer: string): Promise<OidcMetadata> {
    if (this.metadata?.issuer === issuer) return this.metadata;
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error("oidc_discovery_failed");
    const metadata = await response.json() as OidcMetadata;
    if (metadata.issuer !== issuer || !metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error("oidc_discovery_invalid");
    }
    this.metadata = metadata;
    return metadata;
  }
}
