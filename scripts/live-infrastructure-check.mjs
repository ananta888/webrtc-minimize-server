import assert from "node:assert/strict";
import { chromium } from "playwright";
import { forbidLiveCapture, liveJson, liveRequestAllowed } from "./live-infrastructure-boundary.mjs";

export async function runLiveInfrastructure() {
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
        if (candidateTypes.length < 4096) candidateTypes.push(type);
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

  const discovery = await liveJson(`${issuer}/.well-known/openid-configuration`);
  assert.equal(discovery.issuer, issuer, "OIDC issuer must match exactly");
  assert.equal(new URL(discovery.jwks_uri).origin, new URL(issuer).origin, "JWKS must remain on the expected issuer origin");
  const jwks = await liveJson(discovery.jwks_uri);
  assert.ok(jwks.keys.some((key) => key.alg === "RS256"), "JWKS needs an RS256 signing key");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: [], acceptDownloads: false, serviceWorkers: "block" });
    await context.addInitScript(forbidLiveCapture);
    const origins = new Set([new URL(appOrigin).origin, new URL(issuer).origin]);
    await context.route("**/*", route => liveRequestAllowed(route.request().url(), origins)
      ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", () => { if (pageErrors.length < 8) pageErrors.push("page_error"); });
    await page.goto(appOrigin);
    await page.locator("#login").click();
    await page.waitForURL(`${new URL(issuer).origin}/**`);
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator("#kc-login").click();
    try {
      await page.locator("#logout").waitFor({ timeout: 30_000 });
    } catch {
      throw new Error("live_oidc_browser_return_failed");
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
    return evidence.map(([tier, value]) => ({ tier, candidateCount: value.candidateCount, relayCount: value.relayCount }));
  } finally {
    await browser.close();
  }
}
