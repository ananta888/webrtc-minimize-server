import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

if (process.env.RUN_LIVE_MEDIA_AGENT_ONBOARDING !== "1") {
  console.log("SKIP live media-agent onboarding gate: set RUN_LIVE_MEDIA_AGENT_ONBOARDING=1 with explicit test credentials");
  process.exit(0);
}

const appOrigin = process.env.LIVE_APP_ORIGIN || "https://webrtc.ananta.de";
const issuer = process.env.LIVE_OIDC_ISSUER || "https://keycloak.ananta.de/realms/ananta";
const username = process.env.LIVE_OIDC_USERNAME || "";
const password = process.env.LIVE_OIDC_PASSWORD || "";
const action = process.env.LIVE_MEDIA_AGENT_ACTION || "";
const outputDirectory = process.env.LIVE_MEDIA_AGENT_OUTPUT_DIR || "";
const target = process.env.LIVE_MEDIA_AGENT_TARGET || "linux-amd64";
const requestedCount = Number(process.env.LIVE_MEDIA_AGENT_COUNT || "1");
const agentIds = String(process.env.LIVE_MEDIA_AGENT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const AGENT_ID_PATTERN = /^edge-[a-f0-9]{16}$/;
const TARGET_PATTERN = /^(?:linux|macos|windows)-(?:amd64|arm64)$/;
const ACTIONS = new Set(["download", "verify-online", "revoke"]);

assert.ok(username && password, "LIVE_OIDC_USERNAME and LIVE_OIDC_PASSWORD are required");
assert.ok(ACTIONS.has(action), "LIVE_MEDIA_AGENT_ACTION must be download, verify-online or revoke");
assert.ok(new URL(appOrigin).protocol === "https:", "live media-agent app origin must use HTTPS");
assert.ok(new URL(issuer).protocol === "https:", "live media-agent issuer must use HTTPS");
if (action === "download") {
  assert.ok(outputDirectory, "LIVE_MEDIA_AGENT_OUTPUT_DIR is required for download");
  assert.ok(TARGET_PATTERN.test(target), "LIVE_MEDIA_AGENT_TARGET is invalid");
  assert.ok(Number.isSafeInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 3,
    "LIVE_MEDIA_AGENT_COUNT must be between one and three");
} else {
  assert.ok(agentIds.length >= 1 && agentIds.length <= 3 && agentIds.every((id) => AGENT_ID_PATTERN.test(id)),
    "LIVE_MEDIA_AGENT_IDS must contain one to three valid IDs");
}

async function secureOutputDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = await fs.lstat(absolute);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "live output path must be a real directory");
  assert.equal(stat.mode & 0o077, 0, "live output directory must not be accessible by group or others");
  return fs.realpath(absolute);
}

async function login(page) {
  const issuerOrigin = new URL(issuer).origin;
  await page.goto(appOrigin);
  await page.locator("#login").click();
  try {
    await page.waitForURL(`${issuerOrigin}/**`);
  } catch (error) {
    if (!String(error).includes("ERR_NETWORK_CHANGED")) throw error;
    await page.waitForTimeout(500);
    if (new URL(page.url()).origin !== issuerOrigin) {
      await page.goto(appOrigin);
      await page.locator("#login").click();
      await page.waitForURL(`${issuerOrigin}/**`);
    }
  }
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
  await page.locator("#mesh-analysis-navigation").click();
  await page.locator("#media-agent-analysis-panel").waitFor();
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "opening analysis must not invoke capture");
}

async function downloadInstallers(page) {
  const directory = await secureOutputDirectory(outputDirectory);
  const entries = [];
  for (let index = 0; index < requestedCount; index += 1) {
    await page.locator("#media-agent-target").selectOption(target);
    await page.locator("#media-agent-label").fill(`Live Gate ${target} ${index + 1}`);
    const responsePromise = page.waitForResponse((response) => (
      response.url().endsWith("/api/media-agents/enrollments") && response.request().method() === "POST"
    ));
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-media-agent-installer").click();
    const [response, download] = await Promise.all([responsePromise, downloadPromise]);
    assert.equal(response.status(), 201, "live enrollment must be issued");
    const enrollment = await response.json();
    assert.ok(AGENT_ID_PATTERN.test(enrollment.agentId), "live enrollment returned an invalid agent ID");
    assert.equal(enrollment.target, target, "live enrollment target changed");
    assert.ok(Number.isSafeInteger(enrollment.expiresAt) && enrollment.expiresAt > Date.now(),
      "live enrollment already expired");
    assert.match(enrollment.artifactSha256, /^[a-f0-9]{64}$/, "live artifact digest is invalid");
    assert.ok(Number.isSafeInteger(enrollment.artifactBytes) && enrollment.artifactBytes > 0,
      "live artifact size is invalid");
    assert.equal(download.suggestedFilename(), enrollment.filename, "browser download filename changed");
    const filename = path.basename(enrollment.filename);
    assert.equal(filename, enrollment.filename, "live installer filename must not contain a path");
    const destination = path.join(directory, `${index + 1}-${filename}`);
    await assert.rejects(fs.lstat(destination), { code: "ENOENT" });
    await download.saveAs(destination);
    await fs.chmod(destination, 0o600);
    entries.push(Object.freeze({
      agentId: enrollment.agentId,
      target,
      filename: path.basename(destination),
      expiresAt: enrollment.expiresAt,
      artifactSha256: enrollment.artifactSha256,
      artifactBytes: enrollment.artifactBytes,
    }));
  }
  const manifest = path.join(directory, "manifest.json");
  await fs.writeFile(manifest, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "installer download must not invoke capture");
  console.log(`PASS live media-agent explicit installer downloads: ${entries.length}`);
}

async function ownedAgentCard(page, agentId) {
  await page.getByRole("button", { name: "Aktualisieren" }).click();
  const card = page.locator("article.owned-agent", { has: page.locator("code", { hasText: agentId }) });
  await card.waitFor({ timeout: 20_000 });
  return card;
}

async function verifyAgentsOnline(page) {
  for (const agentId of agentIds) {
    const card = await ownedAgentCard(page, agentId);
    await card.getByText(/Linux|macOS|Windows/).waitFor();
    assert.match(await card.textContent(), /online/, `media agent ${agentId} is not online`);
  }
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "inventory refresh must not invoke capture");
  console.log(`PASS live media-agent online inventory: ${agentIds.length}`);
}

async function revokeAgents(page) {
  for (const agentId of agentIds) {
    const card = await ownedAgentCard(page, agentId);
    await card.getByRole("button", { name: "Widerrufen" }).click();
    await card.getByText(/widerrufen/).waitFor({ timeout: 20_000 });
  }
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [], "agent revocation must not invoke capture");
  console.log(`PASS live media-agent UI revocation: ${agentIds.length}`);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true });
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
  await login(page);
  if (action === "download") await downloadInstallers(page);
  if (action === "verify-online") await verifyAgentsOnline(page);
  if (action === "revoke") await revokeAgents(page);
  assert.deepEqual(pageErrors, []);
  await context.close();
} finally {
  await browser.close();
}
