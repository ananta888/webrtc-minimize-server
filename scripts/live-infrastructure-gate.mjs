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
if (!username || !password) throw new Error("LIVE_OIDC_USERNAME and LIVE_OIDC_PASSWORD are required");

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
  const turnServers = session.iceServers.filter((server) => String(server.urls).includes("turn:"));
  assert.ok(turnServers.length > 0, "authorized session must contain ephemeral TURN credentials");
  assert.match(turnServers[0].username, /^\d+:[a-f0-9]{20}$/);
  await page.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "join must not invoke capture");

  const candidates = await page.evaluate(async (iceServers) => {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
    const result = [];
    pc.createDataChannel("turn-gate");
    pc.onicecandidate = (event) => { if (event.candidate) result.push(event.candidate.candidate); };
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
    return result;
  }, turnServers);
  assert.ok(candidates.some((candidate) => / typ relay(?: |$)/.test(candidate)), `TURN relay candidate missing: ${candidates.join(" | ")}`);
  assert.deepEqual(pageErrors, []);
  console.log("PASS live Keycloak PKCE/JWKS, authorized ticket and Coturn relay gate");
} finally {
  await browser.close();
}
