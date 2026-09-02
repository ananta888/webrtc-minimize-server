import assert from "node:assert/strict";
import { chromium } from "playwright";

if (process.env.RUN_LIVE_INFRASTRUCTURE !== "1") {
  console.log("SKIP live Keycloak/TURN gate: set RUN_LIVE_INFRASTRUCTURE=1 with explicit test credentials");
  process.exit(0);
}

const appOrigin = process.env.LIVE_APP_ORIGIN || "http://localhost:8080";
const issuer = process.env.LIVE_OIDC_ISSUER || "http://localhost:8081/realms/webrtc";
const username = process.env.LIVE_OIDC_USERNAME || "";
const password = process.env.LIVE_OIDC_PASSWORD || "";
const requireEdgeTurn = process.env.LIVE_REQUIRE_EDGE_TURN === "1";
const requireInfrastructureTurn = process.env.LIVE_REQUIRE_INFRASTRUCTURE_TURN !== "0";
const expectedEdgeHost = process.env.LIVE_EDGE_TURN_HOST || "";
if (!username || !password) throw new Error("LIVE_OIDC_USERNAME and LIVE_OIDC_PASSWORD are required");

function turnUrls(server) {
  return typeof server?.urls === "string" ? [server.urls] : Array.isArray(server?.urls) ? server.urls : [];
}

function turnHost(url) {
  return /^turns?:([^/?#:]+|\[[^\]]+\])(?::\d+)?(?:\?|$)/i.exec(url)?.[1]?.replace(/^\[|\]$/g, "") || "";
}

function assertEphemeralTurnServers(servers, label) {
  assert.ok(Array.isArray(servers) && servers.length > 0, `${label} TURN servers must be present`);
  for (const server of servers) {
    assert.deepEqual(
      Object.keys(server).sort(),
      ["credential", "credentialType", "urls", "username"],
      `${label} TURN credentials must expose only browser-safe fields`,
    );
    assert.match(server.username, /^\d+:[a-f0-9]{20}$/, `${label} TURN username must be ephemeral`);
    assert.equal(server.credentialType, "password", `${label} TURN credential type must be password`);
    assert.ok(typeof server.credential === "string" && server.credential.length >= 20, `${label} TURN credential is missing`);
    assert.ok(turnUrls(server).every((url) => /^turns?:/i.test(url)), `${label} TURN URLs are invalid`);
  }
}

async function gatherRelayEvidence(page, servers, label) {
  const evidence = await page.evaluate(async (iceServers) => {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
    const candidateTypes = [];
    pc.createDataChannel("turn-gate");
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const type = / typ ([a-z]+)(?: |$)/.exec(event.candidate.candidate)?.[1] || "unknown";
      candidateTypes.push(type);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") resolve();
      else {
        const timeout = setTimeout(resolve, 10_000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        });
      }
    });
    pc.close();
    return { candidateCount: candidateTypes.length, relayCount: candidateTypes.filter((type) => type === "relay").length };
  }, servers);
  assert.ok(evidence.relayCount > 0, `${label} TURN relay candidate missing (${evidence.candidateCount} candidates)`);
  return evidence;
}

const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
assert.equal(discoveryResponse.status, 200, "OIDC discovery must be reachable");
const discovery = await discoveryResponse.json();
assert.equal(discovery.issuer, issuer, "OIDC issuer must match exactly");
const jwksResponse = await fetch(discovery.jwks_uri);
assert.equal(jwksResponse.status, 200, "JWKS must be reachable");
const jwks = await jwksResponse.json();
assert.ok(jwks.keys.some((key) => key.alg === "RS256"), "JWKS needs an RS256 signing key");

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__captureCalls = [];
    const devices = navigator.mediaDevices;
    if (!devices) return;
    for (const method of ["getUserMedia", "getDisplayMedia"]) {
      const original = devices[method]?.bind(devices);
      if (!original) continue;
      devices[method] = (...args) => {
        window.__captureCalls.push(method);
        return original(...args);
      };
    }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(appOrigin);
  await page.locator("#login").click();
  await page.waitForURL(`${new URL(issuer).origin}/**`);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  try {
    await page.locator("#logout").waitFor({ timeout: 30_000 });
  } catch (error) {
    const diagnostic = (await page.locator("body").innerText()).slice(0, 1_500);
    throw new Error(`OIDC browser return failed at ${page.url()}: ${diagnostic}`, { cause: error });
  }
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "login must not invoke capture");

  await page.locator("#display-name").fill("Infrastructure Gate");
  await page.locator("#create-pair").click();
  await page.waitForFunction(() => document.querySelector("#room-id")?.value.startsWith("pair-"));
  const sessionResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/sessions") && response.request().method() === "POST"
  ));
  await page.locator("#join-room").click();
  const sessionResponse = await sessionResponsePromise;
  assert.equal(sessionResponse.status(), 201, "OIDC-authorized session must be issued");
  const session = await sessionResponse.json();
  assert.deepEqual(Object.keys(session.icePolicy).sort(), [
    "directIceServers",
    "infrastructureRelayAfterMs",
    "infrastructureRelayIceServers",
    "peerRelayAfterMs",
    "peerRelayIceServers",
    "version",
  ]);
  assert.equal(session.icePolicy.version, 1);
  assert.ok(session.icePolicy.peerRelayAfterMs < session.icePolicy.infrastructureRelayAfterMs,
    "peer Edge TURN must precede infrastructure TURN");
  assert.ok(session.icePolicy.directIceServers.every((server) => !server.username && !server.credential),
    "direct STUN tier must not receive TURN credentials");
  const edgeTurnServers = session.icePolicy.peerRelayIceServers;
  const infrastructureTurnServers = session.icePolicy.infrastructureRelayIceServers;
  const allTurnServers = [...edgeTurnServers, ...infrastructureTurnServers];
  assert.ok(allTurnServers.length > 0, "authorized session must contain ephemeral TURN credentials");
  if (requireEdgeTurn) {
    assertEphemeralTurnServers(edgeTurnServers, "peer-edge");
    if (expectedEdgeHost) {
      assert.ok(edgeTurnServers.flatMap(turnUrls).every((url) => turnHost(url) === expectedEdgeHost),
        "peer-edge TURN host differs from the explicit live gate target");
    }
  }
  if (requireInfrastructureTurn) assertEphemeralTurnServers(infrastructureTurnServers, "infrastructure");
  await page.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "join must not invoke capture");

  const evidence = [];
  if (requireEdgeTurn) evidence.push(["peer-edge", await gatherRelayEvidence(page, edgeTurnServers, "peer-edge")]);
  if (requireInfrastructureTurn) {
    evidence.push(["infrastructure", await gatherRelayEvidence(page, infrastructureTurnServers, "infrastructure")]);
  }
  if (!requireEdgeTurn && !requireInfrastructureTurn) {
    evidence.push(["configured", await gatherRelayEvidence(page, allTurnServers, "configured")]);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`PASS live Keycloak PKCE/JWKS, authorized ticket and TURN tiers: ${evidence.map(([label]) => label).join(", ")}`);
} finally {
  await browser.close();
}
