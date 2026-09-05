import assert from "node:assert/strict";
import { chromium } from "playwright";

if (process.env.RUN_LIVE_PRODUCTION_BROADCAST !== "1") {
  console.log("SKIP production broadcast gate: provide an isolated test identity and packager");
  process.exit(0);
}

const origin = process.env.LIVE_APP_ORIGIN || "https://webrtc.ananta.de";
const issuer = process.env.LIVE_OIDC_ISSUER || "https://keycloak.ananta.de/realms/ananta";
const username = process.env.LIVE_OIDC_USERNAME || "";
const password = process.env.LIVE_OIDC_PASSWORD || "";
const packagerId = process.env.LIVE_NATIVE_PACKAGER_ID || "";
if (!/^https:\/\/[^/]+$/.test(origin) || !/^https:\/\/[^/]+\/realms\/[A-Za-z0-9._-]+$/.test(issuer)
  || !username || !password || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId)) {
  throw new Error("isolated production broadcast gate configuration is incomplete");
}

const title = `Broadcast gate ${Date.now()}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
let ownerContext;
let viewerContext;
let ownerPage;
let playerManifest = "";
const playbackDiagnostics = [];
const pageErrors = [];
const failedApiResponses = [];

function observePlayback(page) {
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !url.pathname.startsWith("/broadcast/play/")) return;
    playbackDiagnostics.push([
      response.request().method(), url.pathname.split("/").at(-1), response.status(),
      response.headers()["content-type"] || "missing-content-type",
    ].join(" "));
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || !url.pathname.startsWith("/broadcast/play/")) return;
    playbackDiagnostics.push(`${request.method()} ${url.pathname.split("/").at(-1)} failed`);
  });
}

async function login(page) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assert.equal(response?.status(), 200, "application shell must return HTTP 200");
      await page.locator("#login").waitFor({ state: "visible", timeout: 15_000 });
      await page.locator("#login").click();
      await page.waitForURL((url) => url.origin === new URL(issuer).origin, { timeout: 30_000 });
      await page.locator("#username").waitFor({ state: "visible", timeout: 30_000 });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw new Error(`production_oidc_login_unavailable:${new URL(page.url()).origin}`, { cause: lastError });
  }
  assert.equal(new URL(page.url()).origin, new URL(issuer).origin, "login must stay on the configured issuer");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  try {
    await page.locator("#logout").waitFor({ timeout: 30_000 });
  } catch (error) {
    const body = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
    throw new Error(`production_oidc_callback_failed:${new URL(page.url()).origin}:${body}`, { cause: error });
  }
}

async function startVisiblePlayer(page, cardSection) {
  const card = page.locator(`${cardSection} .program-card`, { hasText: title });
  await card.getByRole("button", { name: "Zuschauen" }).click();
  let manifestRequest;
  try {
    [manifestRequest] = await Promise.all([
      page.waitForRequest((request) => request.url().includes("/broadcast/play/")
        && request.url().includes(".m3u8"), { timeout: 20_000 }),
      page.locator("#broadcast-player-start").click(),
    ]);
  } catch (error) {
    const status = (await page.locator("app-broadcast-player").innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
    throw new Error(`broadcast_player_request_timeout:${status}:${failedApiResponses.join("|")}`, { cause: error });
  }
  const decodable = await page.locator("app-broadcast-player video").evaluate(async (video) => {
    const deadline = Date.now() + 25_000;
    while (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  });
  if (!decodable) {
    const status = (await page.locator("app-broadcast-player").innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
    const media = await page.locator("app-broadcast-player video").evaluate((video) => ({
      readyState: video.readyState,
      networkState: video.networkState,
      errorCode: video.error?.code || 0,
      paused: video.paused,
      currentTime: Math.round(video.currentTime * 100) / 100,
      bufferedSeconds: video.buffered.length
        ? Math.round((video.buffered.end(video.buffered.length - 1) - video.buffered.start(0)) * 100) / 100 : 0,
    }));
    throw new Error(`broadcast_video_not_decodable:${status}:${JSON.stringify(media)}:${playbackDiagnostics.join("|")}`);
  }
  return manifestRequest.url();
}

try {
  ownerContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  ownerPage = await ownerContext.newPage();
  observePlayback(ownerPage);
  ownerPage.on("pageerror", (error) => pageErrors.push(error.message));
  ownerPage.on("response", async (response) => {
    if (response.status() < 400 || !response.url().startsWith(`${origin}/api/`)) return;
    let code = "unreadable_response";
    try {
      const body = await response.json();
      if (body && typeof body === "object" && typeof body.error === "string") code = body.error;
    } catch { /* a missing JSON body remains visible as an unreadable response */ }
    failedApiResponses.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()} ${code}`);
  });
  await login(ownerPage);

  await ownerPage.locator("#new-room-title").fill(title);
  await ownerPage.locator("#create-room").click();
  await ownerPage.locator("#display-name").fill("Broadcast Smoke");
  await ownerPage.locator("#join-room").click();
  await ownerPage.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
  await ownerPage.locator("#toggle-camera").click();
  await ownerPage.locator("#toggle-camera[aria-pressed=true]").waitFor();
  await ownerPage.locator("#toggle-microphone").click();
  await ownerPage.locator("#toggle-microphone[aria-pressed=true]").waitFor();

  await ownerPage.locator("#mesh-analysis-navigation").click();
  const packager = ownerPage.locator("#native-packager-analysis-panel .owned-agent", { hasText: packagerId });
  await packager.getByText("online", { exact: false }).waitFor({ timeout: 30_000 });
  const roomConsent = packager.locator(".agent-consent input");
  await roomConsent.check();
  try {
    await ownerPage.waitForFunction((id) => {
      const cards = [...document.querySelectorAll("#native-packager-analysis-panel .owned-agent")];
      const card = cards.find((candidate) => candidate.textContent?.includes(id));
      const input = card?.querySelector(".agent-consent input");
      return input instanceof HTMLInputElement && input.checked && !input.disabled
        && !card?.textContent?.includes("Bestätigung des Agenten ausstehend");
    }, packagerId, { timeout: 10_000 });
  } catch (error) {
    const status = (await packager.innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
    throw new Error(`native_packager_consent_not_confirmed:${status}`, { cause: error });
  }

  await ownerPage.locator("#broadcast-navigation").click();
  const sources = ownerPage.locator("#broadcast-own-source-list input[type=checkbox]");
  await sources.nth(1).waitFor({ timeout: 10_000 });
  assert.equal(await sources.count(), 2, "synthetic camera and microphone must be explicit sources");
  for (let index = 0; index < 2; index += 1) await sources.nth(index).check();
  await ownerPage.locator(`#broadcast-packager-profile option[value="native:${packagerId}"]`)
    .waitFor({ state: "attached", timeout: 10_000 });
  await ownerPage.locator("#broadcast-packager-profile").selectOption(`native:${packagerId}`);
  await ownerPage.locator("#prepare-broadcast-preview").click();
  await ownerPage.locator(".broadcast-heading .status[data-state=ready]").waitFor({ timeout: 20_000 });

  ownerPage.once("dialog", (dialog) => dialog.accept());
  await ownerPage.locator("#broadcast-start-summary").evaluate((details) => { details.open = true; });
  await ownerPage.locator("#broadcast-program-title").fill(title);
  await ownerPage.locator("#broadcast-start").click();
  await ownerPage.locator("#broadcast-stop").waitFor({ timeout: 45_000 });
  await ownerPage.waitForFunction(() => {
    const summary = document.querySelector("#broadcast-start-summary");
    return summary?.textContent?.includes("Zustand running") || Boolean(summary?.querySelector(".error")?.textContent?.trim());
  }, undefined, { timeout: 45_000 });
  const startSummary = await ownerPage.locator("#broadcast-start-summary").innerText();
  if (!startSummary.includes("Zustand running")) {
    const code = await ownerPage.locator("#broadcast-start-summary .error").innerText();
    throw new Error(`production_broadcast_not_running:${code}:${failedApiResponses.join("|")}`);
  }

  const refresh = ownerPage.locator("section#broadcast-audience .audience-heading button");
  await refresh.click();
  playerManifest = await startVisiblePlayer(ownerPage, "section[aria-labelledby=own-broadcasts-heading]");
  await ownerPage.locator("app-broadcast-player .controls button", { hasText: "Schließen" }).click();

  ownerPage.once("dialog", (dialog) => dialog.accept());
  const visibilityResponse = ownerPage.waitForResponse((response) => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname.startsWith("/api/broadcasts/prg_")
  ), { timeout: 20_000 });
  await ownerPage.locator("select#broadcast-audience").selectOption("public");
  const changed = await visibilityResponse;
  const changedBody = await changed.json();
  assert.equal(changed.status(), 200, `public visibility update failed: ${changed.status()}`);
  assert.equal(changedBody?.program?.visibility, "public", "visibility response did not commit public policy");
  assert.match(changedBody?.program?.availability || "", /^(?:live|degraded)$/);
  const publicDirectory = await ownerPage.evaluate(async () => {
    const response = await fetch("/api/broadcasts/public", { cache: "no-store", credentials: "omit" });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(publicDirectory.status, 200);
  assert.equal(publicDirectory.body?.programs?.some((program) => program.title === title), true,
    "public control-plane directory did not expose the committed live program");

  viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  observePlayback(viewer);
  await viewer.goto(`${origin}/?section=broadcast`, { waitUntil: "domcontentloaded" });
  await viewer.locator("#public-broadcasts-heading").waitFor();
  await viewer.locator("section#broadcast-audience .audience-heading button", { hasText: "Aktualisieren" }).click();
  const publicCard = viewer.locator("section[aria-labelledby=public-broadcasts-heading] .program-card", { hasText: title });
  await publicCard.waitFor({ timeout: 20_000 });
  playerManifest = await startVisiblePlayer(viewer, "section[aria-labelledby=public-broadcasts-heading]");

  await ownerPage.locator("#broadcast-stop").click();
  await ownerPage.locator("#broadcast-start").waitFor({ timeout: 20_000 });
  const revoked = await viewer.evaluate(async (url) => (await fetch(url, { cache: "no-store" })).status, playerManifest);
  assert.equal(revoked, 404, "stopped program manifest must be revoked immediately");
  assert.deepEqual(pageErrors, []);

  await ownerPage.locator("#mesh-analysis-navigation").click();
  const currentPackager = ownerPage.locator("#native-packager-analysis-panel .owned-agent", { hasText: packagerId });
  ownerPage.once("dialog", (dialog) => dialog.accept());
  await currentPackager.getByRole("button", { name: "Widerrufen" }).click();
  await currentPackager.getByText("widerrufen", { exact: false }).waitFor();
  await ownerPage.locator("#leave-room").click();

  console.log("PASS production native broadcast: private owner playback, public anonymous playback, stop revoke and packager revoke");
} finally {
  if (ownerPage && !ownerPage.isClosed()) {
    try {
      const stop = ownerPage.locator("#broadcast-stop");
      if (await stop.isVisible()) {
        await stop.click();
        await ownerPage.locator("#broadcast-start").waitFor({ state: "visible", timeout: 20_000 });
      }
    } catch { /* best-effort cleanup; the operator wrapper revokes the isolated identity */ }
  }
  await viewerContext?.close();
  await ownerContext?.close();
  await browser.close();
}
