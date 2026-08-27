import { pathToFileURL } from "node:url";

const DEFAULT_PUBLIC_ORIGIN = "https://webrtc.ananta.de";
const DEFAULT_CLIENT_ID = "webrtc-browser";
const DEFAULT_AUDIENCE = "webrtc-room-server";

function exactHttpOrigin(value, name) {
  const parsed = new URL(value);
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  return parsed.origin;
}

function boundedIdentifier(value, name) {
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return normalized;
}

export function buildKeycloakClientConfig(env = process.env) {
  const origin = exactHttpOrigin(env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN, "PUBLIC_ORIGIN");
  const clientId = boundedIdentifier(env.OIDC_CLIENT_ID || DEFAULT_CLIENT_ID, "OIDC_CLIENT_ID");
  const audience = boundedIdentifier(env.OIDC_AUDIENCE || DEFAULT_AUDIENCE, "OIDC_AUDIENCE");
  return {
    clientId,
    name: "WebRTC Browser",
    description: "Public Angular browser client using Authorization Code Flow with PKCE S256.",
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    protocol: "openid-connect",
    rootUrl: origin,
    baseUrl: "/",
    redirectUris: [`${origin}/oidc-callback`],
    webOrigins: [origin],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": `${origin}/*`,
      "backchannel.logout.session.required": "true",
    },
    defaultClientScopes: ["web-origins", "profile", "email", "roles", "basic"],
    protocolMappers: [{
      name: `${audience}-audience`,
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      consentRequired: false,
      config: {
        "included.custom.audience": audience,
        "access.token.claim": "true",
        "id.token.claim": "false",
      },
    }],
  };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.stdout.write(`${JSON.stringify(buildKeycloakClientConfig(), null, 2)}\n`);
}
