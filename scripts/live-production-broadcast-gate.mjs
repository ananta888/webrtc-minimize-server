import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
import { verifyProductionHandoff } from "./live-production-handoff-gate.mjs";

if (process.env.RUN_LIVE_PRODUCTION_BROADCAST !== "1") {
  console.log("SKIP production broadcast gate: provide an isolated test identity and packager");
  process.exit(0);
}

const origin = process.env.LIVE_APP_ORIGIN || "https://webrtc.ananta.de";
const issuer = process.env.LIVE_OIDC_ISSUER || "https://keycloak.ananta.de/realms/ananta";
const username = process.env.LIVE_OIDC_USERNAME || "";
const password = process.env.LIVE_OIDC_PASSWORD || "";
const packagerId = process.env.LIVE_NATIVE_PACKAGER_ID || "";
const handoffId = process.env.LIVE_NATIVE_PACKAGER_HANDOFF_ID || "";
if ((process.env.LIVE_PRODUCTION_NATIVE_HANDOFF === "1" && !handoffId)
  || (handoffId && (!/^pkr_[A-Za-z0-9_-]{16,64}$/.test(handoffId) || handoffId === packagerId))) {
  throw new Error("isolated handoff gate requires two distinct packagers");
}
const packagerIds = handoffId ? [packagerId, handoffId] : [packagerId];
const assignmentStatuses = [];
const verifyRefreshRestore = process.env.LIVE_PRODUCTION_REFRESH_RESTORE === "1";
const verifyPrivateViewer = process.env.LIVE_PRODUCTION_PRIVATE_VIEWER === "1";
const viewerBrowserName = process.env.LIVE_PRODUCTION_VIEWER_BROWSER || "chromium";
if (!/^https:\/\/[^/]+$/.test(origin) || !/^https:\/\/[^/]+\/realms\/[A-Za-z0-9._-]+$/.test(issuer)
  || !username || !password || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId)
  || !new Set(["chromium", "firefox"]).has(viewerBrowserName)) {
  throw new Error("isolated production broadcast gate configuration is incomplete");
}

const title = `Broadcast gate ${Date.now()}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
let ownerContext;
let viewerContext;
let privateViewerContext;
let ownerPage;
let viewerBrowser;
let playerManifest = "";
const playbackDiagnostics = [];
const pageErrors = [];
const failedApiResponses = [];
const viewerDiagnostics = [];

function observePlayback(page) {
  const counters = { mediaRequests: 0, sessionRenewals: 0 };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith("/broadcast/play/")) counters.mediaRequests += 1;
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || (!url.pathname.startsWith("/broadcast/play/")
      && !url.pathname.includes("/playback")
      && !url.pathname.startsWith("/api/broadcast/playback-sessions"))) return;
    playbackDiagnostics.push([
      response.request().method(), url.pathname, response.status(),
      response.headers()["content-type"] || "missing-content-type",
    ].join(" "));
    if (response.request().method() === "PUT"
      && url.pathname.startsWith("/api/broadcast/playback-sessions/")
      && response.status() === 200) counters.sessionRenewals += 1;
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || (!url.pathname.startsWith("/broadcast/play/")
      && !url.pathname.includes("/playback") && !url.pathname.endsWith(".js"))) return;
    playbackDiagnostics.push(`${request.method()} ${url.pathname} failed ${request.failure()?.errorText || "unknown"}`);
  });
  return counters;
}

function observeFailedApis(page) {
  page.on("response", async (response) => {
    if (response.status() < 400 || !response.url().startsWith(`${origin}/api/`)) return;
    let code = "unreadable_response";
    try {
      const body = await response.json();
      if (body && typeof body === "object" && typeof body.error === "string") code = body.error;
    } catch { /* a missing JSON body remains visible as an unreadable response */ }
    failedApiResponses.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()} ${code}`);
  });
}

async function newViewerContext() {
  if (viewerBrowserName !== "firefox") return browser.newContext();
  if (!viewerBrowser) {
    viewerBrowser = await firefox.launch({ headless: true });
    viewerBrowser.on("disconnected", () => viewerDiagnostics.push("browser_disconnected"));
  }
  return viewerBrowser.newContext();
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
      assert.equal(new URL(page.url()).origin, new URL(issuer).origin,
        "login must stay on the configured issuer");
      await page.locator("#username").fill(username);
      await page.locator("#password").fill(password);
      await page.locator("#kc-login").click();
      await page.locator("#logout").waitFor({ timeout: 30_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await page.waitForTimeout(500);
    }
  }
  const currentOrigin = URL.canParse(page.url()) ? new URL(page.url()).origin : "unparseable";
  const body = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
  throw new Error(`production_oidc_login_unavailable:${currentOrigin}:${body}`, { cause: lastError });
}

async function startVisiblePlayer(page, cardSection, programTitle = title) {
  const card = page.locator(`${cardSection} .program-card`, { hasText: programTitle });
  await card.getByRole("button", { name: "Zuschauen" }).click();
  let manifestRequest;
  try {
    [manifestRequest] = await Promise.all([
      page.waitForRequest((request) => request.url().includes("/broadcast/play/")
        && request.url().includes(".m3u8"), { timeout: 20_000 }),
      page.locator("#broadcast-player-start").click(),
    ]);
  } catch (error) {
    await page.waitForTimeout(250);
    const status = await page.locator("app-broadcast-player").innerText({ timeout: 1_000 })
      .then((value) => value.replaceAll(/\s+/g, " ").slice(0, 500))
      .catch(() => "player_missing");
    const openError = await page.locator("#broadcast-open-error").innerText({ timeout: 1_000 })
      .then((value) => value.replaceAll(/\s+/g, " ").slice(0, 200))
      .catch(() => "open_error_missing");
    throw new Error(`broadcast_player_request_timeout:${status}:${openError}:${playbackDiagnostics.join("|")}:${failedApiResponses.join("|")}`, { cause: error });
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

async function refreshUntilProgramVisible(page, cardSection, programTitle, timeoutMs = 20_000) {
  const card = page.locator(`${cardSection} .program-card`, { hasText: programTitle });
  const refresh = page.locator("#broadcast-audience-directory .audience-heading button", { hasText: "Aktualisieren" });
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    if (await card.isVisible()) return;
    await refresh.click();
    await page.waitForTimeout(100);
    await page.waitForFunction(() => {
      const button = document.querySelector("#broadcast-audience-directory .audience-heading button");
      return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: Math.min(5_000, Math.max(1, deadline - Date.now())) }).catch(() => undefined);
    if (await card.isVisible()) return;
    await page.waitForTimeout(1_000);
  }
  const state = (await page.locator("#broadcast-audience-directory").innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
  throw new Error(`broadcast_directory_refresh_timeout:${cardSection}:${state}`);
}

async function waitForProgramRunning(page, timeoutMs = 60_000) {
  try {
    await page.waitForFunction(() => {
      const status = document.querySelector("#broadcast-program-status");
      const error = document.querySelector("app-broadcast-preflight > .error[role=alert]");
      return status?.textContent?.trim() === "Live" || Boolean(error?.textContent?.trim());
    }, undefined, { timeout: timeoutMs });
  } catch (error) {
    const state = (await page.locator("app-broadcast-preflight").innerText())
      .replaceAll(/\s+/g, " ").slice(0, 1_000);
    throw new Error(`production_broadcast_state_timeout:${state}:${failedApiResponses.join("|")}`, { cause: error });
  }
  const status = (await page.locator("#broadcast-program-status").allInnerTexts()).at(0)?.trim() || "";
  if (status !== "Live") {
    const code = (await page.locator("app-broadcast-preflight > .error[role=alert]").innerText()).trim();
    throw new Error(`production_broadcast_not_running:${code}:${failedApiResponses.join("|")}`);
  }
}

try {
  ownerContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  await ownerContext.addInitScript(() => {
    window.__captureCalls = [];
    window.__broadcastGateConnections = [];
    const NativeConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativeConnection, { construct(Target, args) {
      const connection = Reflect.construct(Target, args);
      window.__broadcastGateConnections.push(connection);
      return connection;
    } });
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
  ownerPage = await ownerContext.newPage();
  ownerPage.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.type === "native-packager-status") {
        assignmentStatuses.push({ programId: message.programId, programEpoch: message.programEpoch,
          packagerId: message.packagerId, state: message.state, reasonCode: message.reasonCode });
        if (assignmentStatuses.length > 128) assignmentStatuses.shift();
      }
    } catch { /* Non-status signaling is neither recorded nor interpreted by this gate. */ }
  }));
  let programCreateRequests = 0;
  ownerPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === "/api/broadcasts" && request.method() === "POST") {
      programCreateRequests += 1;
    }
  });
  observePlayback(ownerPage);
  observeFailedApis(ownerPage);
  ownerPage.on("pageerror", (error) => pageErrors.push(error.message));
  await login(ownerPage);

  await ownerPage.locator("#new-room-title").fill(title);
  const roomCreated = ownerPage.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/rooms"
  ), { timeout: 30_000 });
  await ownerPage.locator("#create-room").click();
  const roomResponse = await roomCreated;
  assert.equal(roomResponse.status(), 201,
    `isolated room creation failed: ${roomResponse.status()} ${failedApiResponses.join("|")}`);
  await ownerPage.waitForFunction(() => {
    const input = document.querySelector("#room-id");
    return input instanceof HTMLInputElement && Boolean(input.value.trim());
  }, undefined, { timeout: 10_000 });
  await ownerPage.locator("#display-name").fill("Broadcast Smoke");
  await ownerPage.locator("#join-room:not([disabled])").waitFor({ timeout: 10_000 });
  await ownerPage.locator("#join-room").click();
  await ownerPage.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
  await ownerPage.locator("#toggle-camera").click();
  await ownerPage.locator("#toggle-camera[aria-pressed=true]").waitFor();
  await ownerPage.locator("#toggle-microphone").click();
  await ownerPage.locator("#toggle-microphone[aria-pressed=true]").waitFor();

  await ownerPage.locator("#mesh-analysis-navigation").click();
  for (const id of packagerIds) {
  const packager = ownerPage.locator("#native-packager-analysis-panel .owned-agent", { hasText: id });
  await packager.getByText("online", { exact: false }).waitFor({ timeout: 30_000 });
  const roomConsent = packager.locator(".agent-consent input");
  await roomConsent.check();
  try {
    await ownerPage.getByRole("status")
      .filter({ hasText: "Native-Packager für diesen Raum freigegeben." })
      .waitFor({ state: "visible", timeout: 15_000 });
    await ownerPage.waitForFunction((id) => {
      const cards = [...document.querySelectorAll("#native-packager-analysis-panel .owned-agent")];
      const card = cards.find((candidate) => candidate.textContent?.includes(id));
      const input = card?.querySelector(".agent-consent input");
      return input instanceof HTMLInputElement && input.checked && !input.disabled
        && !card?.textContent?.includes("Bestätigung des Agenten ausstehend");
    }, id, { timeout: 5_000 });
  } catch (error) {
    const status = (await packager.innerText()).replaceAll(/\s+/g, " ").slice(0, 500);
    throw new Error(`native_packager_consent_not_confirmed:${status}`, { cause: error });
  }
  }

  await ownerPage.locator("#broadcast-navigation").click();
  const sources = ownerPage.locator("#broadcast-own-source-list input[type=checkbox]");
  await sources.nth(1).waitFor({ timeout: 10_000 });
  assert.equal(await sources.count(), 2, "synthetic camera and microphone must be explicit sources");
  for (let index = 0; index < 2; index += 1) await sources.nth(index).check();
  await ownerPage.locator(`#broadcast-packager-profile option[value="native:${packagerId}"]`)
    .waitFor({ state: "attached", timeout: 30_000 });
  await ownerPage.locator("#broadcast-packager-profile").selectOption(`native:${packagerId}`);
  await ownerPage.locator("#prepare-broadcast-preview").click();
  await ownerPage.locator(".broadcast-heading .status[data-state=ready]").waitFor({ timeout: 20_000 });

  ownerPage.once("dialog", (dialog) => dialog.accept());
  await ownerPage.locator("#broadcast-start-summary").evaluate((details) => { details.open = true; });
  await ownerPage.locator("#broadcast-program-title").fill(title);
  await ownerPage.locator("#broadcast-start").click();
  await ownerPage.locator("#broadcast-stop").waitFor({ timeout: 45_000 });
  const liveControl = await ownerPage.locator("#broadcast-stop").evaluate((stop) => {
    const region = stop.closest("[role=region]");
    const status = region?.querySelector("[role=status]");
    stop.focus();
    return {
      outsideCollapsibleSummary: stop.closest("details") === null,
      regionLabelledBy: region?.getAttribute("aria-labelledby") || "",
      statusLiveMode: status?.getAttribute("aria-live") || "",
      keyboardFocusable: document.activeElement === stop,
    };
  });
  assert.deepEqual(liveControl, {
    outsideCollapsibleSummary: true,
    regionLabelledBy: "broadcast-live-control-heading",
    statusLiveMode: "polite",
    keyboardFocusable: true,
  }, "active broadcast must expose an always-visible, labelled and keyboard-focusable kill switch");
  await waitForProgramRunning(ownerPage);
  assert.equal((await ownerPage.locator("#broadcast-program-status").innerText()).trim(), "Live",
    "the persistent live region must announce the running lifecycle in plain language");

  await refreshUntilProgramVisible(ownerPage, "section[aria-labelledby=own-broadcasts-heading]", title);
  playerManifest = await startVisiblePlayer(ownerPage, "section[aria-labelledby=own-broadcasts-heading]");
  const directionBefore = await ownerPage.evaluate(() => ({
    capture: [...window.__captureCalls], connections: window.__broadcastGateConnections.length,
    senderTracks: window.__broadcastGateConnections.flatMap(pc => pc.getSenders().map(sender => sender.track?.id || "")).sort(),
  }));
  const programsBeforeDirection = programCreateRequests;
  const isWaitingImage = (expected = true) => {
    const video = document.querySelector("app-broadcast-player video");
    if (!(video instanceof HTMLVideoElement) || video.readyState < 2) return false;
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 36;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(video, 0, 0, 64, 36);
    const waiting = [[4, 4], [60, 4], [4, 32], [60, 32]].every(([x, y]) => {
      const pixel = context.getImageData(x, y, 1, 1).data;
      return [9, 19, 31].every((value, index) => Math.abs(pixel[index] - value) <= 18);
    });
    return waiting === expected;
  };
  assert.equal(await ownerPage.evaluate(isWaitingImage, false), true, "synthetic source must differ from the waiting slate before direction");
  for (const layout of ["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "end-slate", "waiting-slate"]) {
    await ownerPage.locator("#broadcast-moderation-layout").selectOption(layout);
    await ownerPage.locator("#broadcast-local-video-apply").click();
    await ownerPage.locator(`#broadcast-local-video-status[data-layout="${layout}"]`).waitFor({ timeout: 5000 });
  }
  await ownerPage.waitForFunction(isWaitingImage, undefined, { timeout: 30_000 });
  await ownerPage.locator("#broadcast-moderation-layout").selectOption("screen-presenter");
  await ownerPage.locator("#broadcast-local-video-apply").click();
  // Evaluate the same actual decoded HLS pixels, not only the local layout label.
  await ownerPage.waitForFunction(isWaitingImage, false, { timeout: 30_000 });
  assert.equal(await ownerPage.locator("#broadcast-local-video-error").count(), 0);
  assert.equal((await ownerPage.locator("#broadcast-program-status").innerText()).trim(), "Live");
  assert.equal(programCreateRequests, programsBeforeDirection, "live direction must not create a replacement program");
  assert.deepEqual(await ownerPage.evaluate(() => ({
    capture: [...window.__captureCalls], connections: window.__broadcastGateConnections.length,
    senderTracks: window.__broadcastGateConnections.flatMap(pc => pc.getSenders().map(sender => sender.track?.id || "")).sort(),
  })), directionBefore, "live direction must preserve capture, PeerConnections and sender tracks");
  console.log("PASS production local video direction: decoded HLS slate and source return without new program, capture, connection or track");
  await ownerPage.locator("app-broadcast-player .controls button", { hasText: "Schließen" }).click();
  if (verifyPrivateViewer) {
    privateViewerContext = await newViewerContext();
    const privateViewer = await privateViewerContext.newPage();
    observePlayback(privateViewer);
    observeFailedApis(privateViewer);
    await login(privateViewer);
    await privateViewer.locator("#broadcast-navigation").click();
    await refreshUntilProgramVisible(privateViewer, "section[aria-labelledby=own-broadcasts-heading]", title);
    const privateManifest = await startVisiblePlayer(privateViewer, "section[aria-labelledby=own-broadcasts-heading]");
    if (handoffId) await verifyProductionHandoff({ owner: ownerPage, viewer: privateViewer, targetId: handoffId,
      programCreates: () => programCreateRequests, statuses: assignmentStatuses, manifest: privateManifest });
    assert.equal(await privateViewer.locator("#leave-room").count(), 0,
      "authenticated private viewers must not receive room membership");
    await privateViewer.locator("app-broadcast-player .controls button", { hasText: "Schließen" }).click();
    await privateViewerContext.close();
    privateViewerContext = undefined;
  }
  const captureCallsBeforeVisibility = await ownerPage.evaluate(() => [...window.__captureCalls]);

  ownerPage.once("dialog", (dialog) => dialog.accept());
  const visibilityStopResponse = ownerPage.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && new URL(response.url()).pathname.startsWith("/api/broadcasts/prg_")
  ), { timeout: 30_000 });
  const visibilityCreateResponse = ownerPage.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/broadcasts") return false;
    try { return response.request().postDataJSON()?.visibility === "public"; } catch { return false; }
  }, { timeout: 30_000 });
  await ownerPage.locator("select#broadcast-audience").selectOption("public");
  const [visibilityStop, visibilityCreate] = await Promise.all([
    visibilityStopResponse,
    visibilityCreateResponse,
  ]);
  assert.equal(visibilityStop.status(), 200, "old program was not fenced before its visibility restart");
  assert.equal(visibilityCreate.status(), 201, "public replacement program was not created");
  await waitForProgramRunning(ownerPage);
  assert.deepEqual(await ownerPage.evaluate(() => window.__captureCalls), captureCallsBeforeVisibility,
    "visibility restart must reuse explicit sources without requesting capture again");
  const publicDirectory = await ownerPage.evaluate(async () => {
    const response = await fetch("/api/broadcasts/public", { cache: "no-store", credentials: "omit" });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(publicDirectory.status, 200);
  const publicProgram = publicDirectory.body?.programs?.find((program) => program.title === title);
  assert.ok(publicProgram, "public control-plane directory did not expose the committed live program");
  assert.match(publicProgram.programId, /^prg_[A-Za-z0-9_-]{16,64}$/);

  viewerContext = await newViewerContext();
  const viewer = await viewerContext.newPage();
  viewer.on("crash", () => viewerDiagnostics.push("page_crashed"));
  viewer.on("close", () => viewerDiagnostics.push("page_closed"));
  viewer.on("pageerror", () => viewerDiagnostics.push("page_error"));
  const viewerPlayback = observePlayback(viewer);
  observeFailedApis(viewer);
  await viewer.goto(
    `${origin}/?section=broadcast&program=${encodeURIComponent(publicProgram.programId)}`,
    { waitUntil: "domcontentloaded" },
  );
  await viewer.locator("#public-broadcasts-heading").waitFor();
  await viewer.locator("#broadcast-deep-link-state").waitFor();
  assert.equal(await viewer.locator("app-broadcast-player").count(), 0,
    "a broadcast deep link must not authorize or start playback without a local click");
  await refreshUntilProgramVisible(viewer, "section[aria-labelledby=public-broadcasts-heading]", title);
  const renewedSession = viewer.waitForResponse((response) => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname.startsWith("/api/broadcast/playback-sessions/")
  ), { timeout: 140_000 }).then(
    (response) => ({ response, error: null }),
    (error) => ({ response: null, error }),
  );
  playerManifest = await startVisiblePlayer(viewer, "section[aria-labelledby=public-broadcasts-heading]");
  const renewalResult = await renewedSession;
  if (!renewalResult.response) {
    throw new Error(`broadcast_playback_renewal_unavailable:${viewerDiagnostics.join("|")}:${playbackDiagnostics.slice(-20).join("|")}`, {
      cause: renewalResult.error,
    });
  }
  const renewalResponse = renewalResult.response;
  assert.equal(renewalResponse.status(), 200, "active anonymous playback session was not renewed");
  assert.equal(viewerPlayback.sessionRenewals, 1,
    "one scoped playback-session renewal was expected before the first grant expired");
  if (handoffId) playerManifest = await verifyProductionHandoff({ owner: ownerPage, viewer,
    targetId: verifyPrivateViewer ? packagerId : handoffId, programCreates: () => programCreateRequests,
    statuses: assignmentStatuses, manifest: playerManifest });

  await ownerPage.locator("#broadcast-stop").click();
  await ownerPage.locator("#broadcast-start", {
    hasText: "Programm anlegen und Start bestätigen",
  }).waitFor({ timeout: 30_000 });
  try {
    await viewer.waitForFunction(() => (
      document.querySelector("app-broadcast-player .state")?.getAttribute("data-state") === "ended"
      || document.querySelector("#broadcast-open-error")?.textContent?.includes("broadcast_ended")
    ), undefined, { timeout: 45_000 });
  } catch (error) {
    const status = (await viewer.locator("#broadcast-audience-directory").innerText())
      .replaceAll(/\s+/g, " ").slice(0, 700);
    throw new Error(`broadcast_player_terminal_timeout:${status}:${playbackDiagnostics.slice(-20).join("|")}`, {
      cause: error,
    });
  }
  const terminalMediaRequests = viewerPlayback.mediaRequests;
  let settledMediaRequests = terminalMediaRequests;
  const drainDeadline = Date.now() + 5_000;
  do {
    await viewer.waitForTimeout(1_000);
    const observed = viewerPlayback.mediaRequests;
    if (observed === settledMediaRequests) break;
    settledMediaRequests = observed;
  } while (Date.now() < drainDeadline);
  assert.ok(settledMediaRequests - terminalMediaRequests <= 2,
    "terminal player may drain at most two already scheduled media requests");
  await viewer.waitForTimeout(2_500);
  assert.equal(viewerPlayback.mediaRequests, settledMediaRequests,
    "terminal player must stop manifest and segment requests after revocation");
  const revoked = await viewer.evaluate(async (url) => (await fetch(url, { cache: "no-store" })).status, playerManifest);
  assert.equal(revoked, 404, "stopped program manifest must be revoked immediately");

  if (verifyRefreshRestore) {
    const refreshTitle = `${title} refresh`;
    await ownerPage.locator("#prepare-broadcast-preview").click();
    await ownerPage.locator(".broadcast-heading .status[data-state=ready]").waitFor({ timeout: 20_000 });
    await ownerPage.locator("#broadcast-start:not([disabled])").waitFor({ timeout: 20_000 });
    ownerPage.once("dialog", (dialog) => dialog.accept());
    await ownerPage.locator("#broadcast-start-summary").evaluate((details) => { details.open = true; });
    await ownerPage.locator("#broadcast-program-title").fill(refreshTitle);
    await ownerPage.locator("#broadcast-start").click();
    await waitForProgramRunning(ownerPage);
    await refreshUntilProgramVisible(ownerPage, "section[aria-labelledby=own-broadcasts-heading]", refreshTitle);
    const refreshManifest = await startVisiblePlayer(
      ownerPage,
      "section[aria-labelledby=own-broadcasts-heading]",
      refreshTitle,
    );
    await ownerPage.locator("app-broadcast-player .controls button", { hasText: "Schließen" }).click();
    const createRequestsBeforeRefresh = programCreateRequests;
    await ownerPage.reload({ waitUntil: "domcontentloaded" });
    await ownerPage.locator("#broadcast-preflight-heading").waitFor({ timeout: 30_000 });
    await ownerPage.waitForTimeout(2_000);
    assert.deepEqual(await ownerPage.evaluate(() => window.__captureCalls), [],
      "refresh during active native output must not restart capture");
    assert.equal(programCreateRequests, createRequestsBeforeRefresh,
      "refresh during active native output must not create or restart a program");
    await ownerPage.waitForFunction(async (manifest) => {
      try { return (await fetch(manifest, { cache: "no-store" })).status === 404; } catch { return false; }
    }, refreshManifest, { timeout: 20_000 });
    assert.equal(await ownerPage.locator("#broadcast-stop").count(), 0,
      "restored cockpit must not present stale local ownership of the stopped program");
  }
  assert.deepEqual(pageErrors, []);

  await ownerPage.locator("#mesh-analysis-navigation").click();
  for (const id of packagerIds) {
  const currentPackager = ownerPage.locator("#native-packager-analysis-panel .owned-agent", { hasText: id });
  ownerPage.once("dialog", (dialog) => dialog.accept());
  await currentPackager.getByRole("button", { name: "Widerrufen" }).click();
  await currentPackager.getByText("widerrufen", { exact: false }).waitFor();
  }
  const leaveRoom = ownerPage.locator("#leave-room");
  if (await leaveRoom.isVisible()) await leaveRoom.click();

  console.log("PASS production native broadcast: private owner playback, renewable public anonymous playback, terminal stop and packager revoke");
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
  await privateViewerContext?.close();
  await ownerContext?.close();
  await viewerBrowser?.close();
  await browser.close();
}
