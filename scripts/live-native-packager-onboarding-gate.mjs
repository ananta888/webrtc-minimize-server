import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

if (process.env.RUN_LIVE_NATIVE_PACKAGER_ONBOARDING !== "1") {
  console.log("SKIP live native-packager onboarding gate: set RUN_LIVE_NATIVE_PACKAGER_ONBOARDING=1 with explicit test credentials");
  process.exit(0);
}

const appOrigin = process.env.LIVE_APP_ORIGIN || "https://webrtc.ananta.de";
const issuer = process.env.LIVE_OIDC_ISSUER || "https://keycloak.ananta.de/realms/ananta";
const username = process.env.LIVE_OIDC_USERNAME || "";
const password = process.env.LIVE_OIDC_PASSWORD || "";
const action = process.env.LIVE_NATIVE_PACKAGER_ACTION || "";
const outputDirectory = process.env.LIVE_NATIVE_PACKAGER_OUTPUT_DIR || "";
const target = process.env.LIVE_NATIVE_PACKAGER_TARGET || "linux-amd64";
const requestedCount = Number(process.env.LIVE_NATIVE_PACKAGER_COUNT || "1");
const packagerIds = String(process.env.LIVE_NATIVE_PACKAGER_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const PACKAGER_ID = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const TARGET = /^(?:linux|macos|windows)-(?:amd64|arm64)$/;
const ACTIONS = new Set(["download", "verify-online", "revoke"]);

assert.ok(username && password, "LIVE_OIDC_USERNAME and LIVE_OIDC_PASSWORD are required");
assert.ok(ACTIONS.has(action), "LIVE_NATIVE_PACKAGER_ACTION must be download, verify-online or revoke");
assert.equal(new URL(appOrigin).protocol, "https:", "live native-packager app origin must use HTTPS");
assert.equal(new URL(issuer).protocol, "https:", "live native-packager issuer must use HTTPS");
if (action === "download") {
  assert.ok(outputDirectory, "LIVE_NATIVE_PACKAGER_OUTPUT_DIR is required for download");
  assert.ok(TARGET.test(target), "LIVE_NATIVE_PACKAGER_TARGET is invalid");
  assert.ok(Number.isSafeInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 3,
    "LIVE_NATIVE_PACKAGER_COUNT must be between one and three");
} else {
  assert.ok(packagerIds.length >= 1 && packagerIds.length <= 3 && packagerIds.every((id) => PACKAGER_ID.test(id)),
    "LIVE_NATIVE_PACKAGER_IDS must contain one to three valid IDs");
}

async function secureOutputDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = await fs.lstat(absolute);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "live output path must be a real directory");
  assert.equal(stat.mode & 0o077, 0, "live output directory must not be accessible by group or others");
  return fs.realpath(absolute);
}

async function login(page) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(`${appOrigin}/?section=analysis`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(() => document.querySelector("#login") || document.querySelector("#logout"), null, {
        timeout: 20_000,
      });
      if (!(await page.locator("#logout").isVisible())) {
        await page.locator("#login").click();
        await page.waitForFunction(() => document.querySelector("#username") || document.querySelector("#logout"), null, {
          timeout: 30_000,
        });
        if (await page.locator("#username").isVisible()) {
          assert.equal(new URL(page.url()).origin, new URL(issuer).origin,
            "credentials must only be entered at the configured issuer");
          await page.locator("#username").fill(username);
          await page.locator("#password").fill(password);
          await page.locator("#kc-login").click();
        }
        await page.locator("#logout").waitFor({ timeout: 30_000 });
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500 * attempt);
    }
  }
  if (lastError) {
    const state = await page.evaluate(() => ({
      origin: window.location.origin,
      pathname: window.location.pathname,
      loginVisible: Boolean(document.querySelector("#login")),
      logoutVisible: Boolean(document.querySelector("#logout")),
      keycloakFormVisible: Boolean(document.querySelector("#username")),
    })).catch(() => ({ origin: "unavailable", pathname: "unavailable", loginVisible: false,
      logoutVisible: false, keycloakFormVisible: false }));
    throw new Error(`native_packager_oidc_login_unavailable:${JSON.stringify(state)}`, { cause: lastError });
  }
  await page.locator("#mesh-analysis-navigation").click();
  await page.locator("#native-packager-analysis-panel").waitFor();
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [],
    "login and opening analysis must not invoke capture");
}

async function downloadInstallers(page) {
  const directory = await secureOutputDirectory(outputDirectory);
  const entries = [];
  for (let index = 0; index < requestedCount; index += 1) {
    await page.locator("#native-packager-target").selectOption(target);
    await page.locator("#native-packager-label").fill(`Live Gate ${target} ${index + 1}`);
    const responsePromise = page.waitForResponse((response) => (
      response.url().endsWith("/api/native-packagers/enrollments") && response.request().method() === "POST"
    ));
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-native-packager-installer").click();
    const [response, download] = await Promise.all([responsePromise, downloadPromise]);
    const enrollment = await response.json();
    assert.equal(response.status(), 201,
      `live enrollment must be issued, received ${response.status()} ${String(enrollment.error || "unknown").slice(0, 80)}`);
    assert.ok(PACKAGER_ID.test(enrollment.packagerId), "live enrollment returned an invalid packager ID");
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
      packagerId: enrollment.packagerId,
      target,
      filename: path.basename(destination),
      expiresAt: enrollment.expiresAt,
      artifactSha256: enrollment.artifactSha256,
      artifactBytes: enrollment.artifactBytes,
    }));
  }
  await fs.writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [],
    "installer creation must not invoke capture");
  console.log(`PASS live native-packager explicit installer downloads: ${entries.length}`);
}

async function ownedPackagerCard(page, packagerId) {
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren" }).click();
  const card = page.locator("#native-packager-analysis-panel article.owned-agent", {
    has: page.locator("code", { hasText: packagerId }),
  });
  await card.waitFor({ timeout: 20_000 });
  return card;
}

async function verifyPackagersOnline(page) {
  for (const packagerId of packagerIds) {
    const card = await ownedPackagerCard(page, packagerId);
    assert.match(await card.textContent(), /Linux|macOS|Windows/);
    await card.getByText("online", { exact: false }).waitFor({ timeout: 20_000 });
  }
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [],
    "inventory refresh must not invoke capture");
  console.log(`PASS live native-packager online inventory: ${packagerIds.length}`);
}

async function revokePackagers(page) {
  for (const packagerId of packagerIds) {
    const card = await ownedPackagerCard(page, packagerId);
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Widerrufen" }).click();
    await card.getByText("widerrufen", { exact: false }).waitFor({ timeout: 20_000 });
  }
  assert.deepEqual(await page.evaluate(() => window.__captureCalls), [],
    "packager revocation must not invoke capture");
  console.log(`PASS live native-packager UI revocation: ${packagerIds.length}`);
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
  page.on("pageerror", (error) => pageErrors.push(error.name || "Error"));
  await login(page);
  if (action === "download") await downloadInstallers(page);
  if (action === "verify-online") await verifyPackagersOnline(page);
  if (action === "revoke") await revokePackagers(page);
  assert.deepEqual(pageErrors, []);
  await context.close();
} finally {
  await browser.close();
}
