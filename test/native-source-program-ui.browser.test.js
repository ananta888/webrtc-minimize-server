import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { chromium } from "playwright";
import { createAppServer } from "../src/server.js";
import { createOidcVerifier } from "../src/oidc-verifier.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { machineFixtureAssets } from "./helpers/machine-fixture-assets.mjs";

// Real built Angular + OIDC verification/P-256 room admission. Native HTTP is
// explicitly a deterministic fixture here; this is not a native encoder/HLS gate.
test("Angular keyboard starts an empty v4 program only after confirmation, waits for output and retains Stop across panels",
  { timeout: 60000 }, async t => {
    try { await fs.access(chromium.executablePath()); } catch { t.skip("Playwright Chromium required for native source UI gate"); return; }
    const issuer = "https://synthetic-identity.example/realm/test", keys = generateKeyPairSync("ed25519");
    const config = { authMode: "required", oidcIssuer: issuer, oidcAudience: "human", oidcAlgorithms: ["EdDSA"], publicOrigin: "",
      nativePackagerSelfServiceEnabled: true, broadcastNativeOutputEnabled: true, stunUrls: [], turnServers: [] };
    const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }) });
    const app = createAppServer({ config, oidcVerifier,
      publicDir: await machineFixtureAssets(process.env.MEET_TEST_PUBLIC_DIR),
      broadcastRuntime: new BroadcastRuntimeRegistry({ grantAuthority: { issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {} } }),
      nativePackagerEnrollmentStore: { definitions: () => [], list: () => [] }, nativePackagerInstallerService: { availableTargets: () => [] } });
    let browser;
    t.after(async () => {
      await browser?.close();
      for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer].filter(Boolean)) {
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
      }
      app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const token = await new SignJWT({}).setIssuer(issuer).setAudience("human").setSubject("owner").setIssuedAt()
      .setExpirationTime("2m").setProtectedHeader({ alg: "EdDSA" }).sign(keys.privateKey);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ permissions: [] });
    await context.addInitScript(token => {
      sessionStorage.setItem("webrtc.oidc.access-token", token);
      window.__nativeSourceUiCapture = 0; window.__nativeSourceUiConnections = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) navigator.mediaDevices[method] = () => {
        window.__nativeSourceUiCapture++; throw new Error("capture_forbidden");
      };
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__nativeSourceUiConnections++; } };
    }, token);
    const roomId = "room-alpha", packagerId = "pkr_aaaaaaaaaaaaaaaa";
    const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId, programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 };
    const assignment = { assignmentId: "asn_aaaaaaaaaaaaaaaa", packagerId, programId: program.programId, roomId,
      programEpoch: 2, fencingRevision: 4, profileId: "h264-aac-720p-v1", renditionIds: ["low"], state: "preparing",
      reasonCode: "AWAITING_AGENT", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60000 };
    const packager = { id: packagerId, label: "Synthetic source packager", platform: "linux", keyFingerprint: "a".repeat(43),
      createdAt: 1, lastAuthenticatedAt: 1, revokedAt: 0, online: true, consentedRoomIds: [roomId], confirmedRoomIds: [roomId],
      capability: { ffmpegVersion: "fixture", health: "healthy", maximumRenditions: 3, capabilityVersion: 2, sourcePrograms: true }, heartbeat: null };
    let outputReady = false, creates = 0, starts = 0, programStops = 0, assignmentStops = 0, startBody;
    let ownRequests = 0, ownBody;
    const page = await context.newPage();
    await page.route("**/api/native-packagers", route => route.fulfill({ json: { packagers: [packager], assignments: [] } }));
    await page.route("**/api/broadcasts", route => {
      if (route.request().method() !== "POST") return route.continue();
      creates++; return route.fulfill({ status: 201, json: { control: program, program: { directoryVersion: 1 } } });
    });
    await page.route(`**/api/broadcasts/${program.programId}/native-source-programs`, route => {
      starts++; startBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { program: { ...program, programRevision: 3, programEpoch: 2 },
        ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", assignment } });
    });
    await page.route(`**/api/broadcasts/${program.programId}/native-handoff-control`, route => route.fulfill({ json: {
      controlVersion: 1, programId: program.programId, programRevision: 4, programEpoch: 2,
      state: outputReady ? "live" : "preparing", handoffPending: false, writer: { packagerId, fencingRevision: 4 } } }));
    await page.route("**/api/broadcast-source-requests", route => {
      ownRequests++; ownBody = route.request().postDataJSON();
      const owner = app.registry.members(roomId)[0], now = Date.now();
      return route.fulfill({ status: 201, json: { responseVersion: 1, requests: [{
        requestId: "bsr_" + "a".repeat(24), roomId, programId: program.programId, programRevision: 4, programEpoch: 2,
        ownerPeerId: owner.id, targetPeerId: owner.id, packagerRef: packagerId, sourceKind: ownBody.sourceKind,
        state: "pending", authority: "none", createdAt: now, expiresAt: now + 120000,
      }] } });
    });
    await page.route(`**/api/broadcasts/${program.programId}`, route => {
      assert.equal(route.request().method(), "DELETE"); programStops++;
      return route.fulfill({ json: { program: { directoryVersion: 1, programId: program.programId, title: "Synthetic program",
        ownerLabel: null, ownerVisibility: "hidden", visibility: "private", availability: "ended", viewerCount: 0,
        latencyMode: "ll-hls", captions: false, programEpoch: 2, policyRevision: 1, playback: "grant-required" } } });
    });
    await page.route(`**/api/native-packagers/${packagerId}/assignments/${assignment.assignmentId}`, route => {
      assert.equal(route.request().method(), "DELETE"); assignmentStops++; return route.fulfill({ json: { assignment: { ...assignment, state: "stopped" } } });
    });
    await page.goto(origin + "/?room=" + roomId);
    await page.locator("#display-name").fill("Synthetic source director");
    await page.locator("#join-room:not([disabled])").waitFor(); await page.locator("#join-room").press("Enter");
    await page.locator("#participant-count", { hasText: "1 / 20" }).waitFor({ timeout: 10000 });
    const initialConnections = await page.evaluate(() => window.__nativeSourceUiConnections);
    await page.locator("#broadcast-navigation").press("Enter");
    await page.locator("#native-source-program-open").press("Enter");
    await page.locator("#native-source-packager").selectOption(packagerId);
    assert.equal(creates, 0); assert.equal(starts, 0);
    const cancelled = page.waitForEvent("dialog");
    const cancelClick = page.locator("#native-source-start").press("Enter");
    await (await cancelled).dismiss(); await cancelClick; assert.equal(creates, 0);
    const confirmed = page.waitForEvent("dialog"); const startClick = page.locator("#native-source-start").press("Enter");
    const dialog = await confirmed; assert.match(dialog.message(), /nicht SFrame-E2EE/); await dialog.accept(); await startClick;
    await page.locator("#native-source-status", { hasText: "Warte auf bestätigte Packager-Ausgabe" }).waitFor();
    assert.equal(starts, 1); assert.equal(creates, 1);
    assert.deepEqual(Object.keys(startBody).sort(), ["allowHardwareAcceleration", "deviceFingerprint", "inputMode", "packagerId", "requestVersion", "requestedRenditions", "trigger"]);
    assert.equal(startBody.inputMode, "trusted-sframe-v1"); assert.equal(startBody.allowHardwareAcceleration, false);
    await page.locator("#broadcast-source-requests-open").press("Enter");
    await page.locator("#broadcast-source-requests-load").waitFor();
    assert.equal(await page.locator("#broadcast-source-request-target").count(), 0);
    outputReady = true;
    await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor();
    await page.locator("#broadcast-source-request-target").waitFor();
    assert.equal(ownRequests, 0);
    assert.equal(await page.locator("#broadcast-source-request-target").inputValue(), "");
    const cancelledOwn = page.waitForEvent("dialog"), cancelledOwnClick = page.locator("#broadcast-source-request-own").press("Enter");
    await (await cancelledOwn).dismiss(); await cancelledOwnClick; assert.equal(ownRequests, 0);
    const confirmedOwn = page.waitForEvent("dialog"), ownClick = page.locator("#broadcast-source-request-own").press("Enter");
    const ownDialog = await confirmedOwn; assert.match(ownDialog.message(), /keine Entschlüsselungsfreigabe/);
    await ownDialog.accept(); await ownClick;
    await page.getByText("Meine eigene Quelle", { exact: true }).waitFor();
    assert.equal(ownRequests, 1); assert.equal(ownBody.action, "create-own");
    assert.equal(Object.hasOwn(ownBody, "targetPeerId"), false);
    assert.equal(ownBody.expectedProgramRevision, 4); assert.equal(ownBody.sourceKind, "camera");
    assert.equal(await page.locator("#broadcast-source-approval").count(), 0, "own intent is not an automatic query or decrypt consent");
    await page.locator("#mesh-analysis-navigation").press("Enter");
    await page.locator("#native-packager-analysis-panel").waitFor(); assert.equal(programStops, 0);
    await page.locator("#broadcast-navigation").press("Enter"); await page.locator("#native-source-program-open").press("Enter");
    await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor();
    await page.locator("#native-source-stop").press("Enter");
    await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor();
    assert.equal(programStops, 1); assert.equal(assignmentStops, 1);
    assert.equal(await page.evaluate(() => window.__nativeSourceUiCapture), 0);
    assert.equal(await page.evaluate(() => window.__nativeSourceUiConnections), initialConnections);
  });
