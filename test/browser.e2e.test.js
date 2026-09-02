import fs from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox } from "playwright";

import { createAppServer } from "../src/server.js";

const cameraContinuityWindowMs = Math.max(4_000, Math.min(
  180_000,
  Number.parseInt(process.env.CAMERA_CONTINUITY_WINDOW_MS || "4000", 10) || 4_000,
));

test("two Chromium pages negotiate chat, camera, microphone and screen", { timeout: cameraContinuityWindowMs + 35_000 }, async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed; run: npx playwright install chromium");
    return;
  }
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
      mediaE2eeMode: "required",
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });
  context.after(async () => {
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const browserContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  await browserContext.addInitScript(() => {
    window.__captureCalls = [];
    window.__captureConstraints = [];
    window.__appliedTrackConstraints = [];
    window.__localTrackSources = {};
    window.__localTracks = {};
    window.__senderParameterEvents = [];
    window.__forceLowBitrateLink = false;
    for (const method of ["getUserMedia", "getDisplayMedia"]) {
      const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
      navigator.mediaDevices[method] = async (...args) => {
        window.__captureCalls.push(method);
        window.__captureConstraints.push({
          method,
          constraints: JSON.parse(JSON.stringify(args[0] || {})),
        });
        const stream = await original(...args);
        const constraints = args[0] || {};
        const source = method === "getDisplayMedia" ? "screen" : constraints.video ? "camera" : "microphone";
        for (const track of stream.getTracks()) {
          window.__localTrackSources[track.id] = source;
          window.__localTracks[track.id] = track;
        }
        return stream;
      };
    }
    const nativeApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
    MediaStreamTrack.prototype.applyConstraints = async function observedApplyConstraints(constraints) {
      await nativeApplyConstraints.call(this, constraints);
      window.__appliedTrackConstraints.push({
        trackId: this.id,
        constraints: JSON.parse(JSON.stringify(constraints || {})),
        settings: JSON.parse(JSON.stringify(this.getSettings())),
      });
    };
    const nativeGetStats = RTCPeerConnection.prototype.getStats;
    RTCPeerConnection.prototype.getStats = async function observedGetStats(...args) {
      const report = await nativeGetStats.apply(this, args);
      if (!window.__forceLowBitrateLink) return report;
      const forced = new Map();
      report.forEach((value, key) => {
        forced.set(key, value.type === "candidate-pair" && value.state === "succeeded"
          ? { ...value, availableOutgoingBitrate: 100_000, currentRoundTripTime: 0.05 }
          : value);
      });
      return forced;
    };
    const nativeSetParameters = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function observedSetParameters(parameters) {
      const event = {
        trackId: this.track?.id || "",
        encodings: parameters.encodings.map((encoding) => ({
          active: encoding.active,
          maxBitrate: encoding.maxBitrate,
          maxFramerate: encoding.maxFramerate,
          scaleResolutionDownBy: encoding.scaleResolutionDownBy,
          priority: encoding.priority,
          networkPriority: encoding.networkPriority,
        })),
        succeeded: null,
      };
      window.__senderParameterEvents.push(event);
      return nativeSetParameters.call(this, parameters).then((result) => {
        event.succeeded = true;
        return result;
      }, (error) => {
        event.succeeded = false;
        throw error;
      });
    };
  });
  const ada = await browserContext.newPage();
  const grace = await browserContext.newPage();
  const pageErrors = [];
  for (const page of [ada, grace]) page.on("pageerror", (error) => pageErrors.push(error.message));

  await ada.goto(origin);
  await ada.locator(".nav-item", { hasText: "Einstellungen" }).click();
  await ada.locator("#camera-resolution").selectOption("360p");
  await ada.locator("#camera-frame-rate").selectOption({ label: "5 FPS" });
  await ada.locator("#screen-resolution").selectOption("480p");
  await ada.locator("#screen-frame-rate").selectOption({ label: "10 FPS" });
  assert.equal(await ada.locator("#media-strategy-preset").inputValue(), "conversation");
  assert.equal(await ada.locator("#audio-quality-profile").inputValue(), "speech-clear");
  assert.deepEqual(await Promise.all([1, 2, 3].map((rank) => ada.locator(`#media-priority-${rank}`).inputValue())), [
    "microphone",
    "camera",
    "screen",
  ]);
  await ada.locator("#media-strategy-preset").selectOption("presentation");
  assert.deepEqual(await Promise.all([1, 2, 3].map((rank) => ada.locator(`#media-priority-${rank}`).inputValue())), [
    "screen",
    "microphone",
    "camera",
  ]);
  await ada.locator("#media-priority-1").selectOption("camera");
  assert.equal(await ada.locator("#media-strategy-preset").inputValue(), "custom");
  assert.deepEqual(await Promise.all([1, 2, 3].map((rank) => ada.locator(`#media-priority-${rank}`).inputValue())), [
    "camera",
    "microphone",
    "screen",
  ]);
  await ada.locator("#media-strategy-preset").selectOption("conversation");
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), []);
  assert.equal(await ada.locator("#microphone-applied-settings").textContent(), "Nicht aktiv");
  assert.equal(await ada.locator("#camera-applied-settings").textContent(), "Nicht aktiv");
  assert.equal(await ada.locator("#screen-applied-settings").textContent(), "Nicht aktiv");
  await ada.locator(".nav-item", { hasText: "Räume" }).click();
  await ada.locator("#display-name").fill("Ada");
  await ada.locator("#create-room").click();
  await ada.waitForFunction(() => document.querySelector("#room-id").value.startsWith("room-"));
  const roomId = await ada.locator("#room-id").inputValue();
  assert.match(roomId, /^room-[a-f0-9]{18}$/);
  await ada.locator("#join-room").click();
  await ada.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();

  await grace.goto(`${origin}/?room=${roomId}`);
  await grace.locator("#display-name").fill("Grace");
  await grace.locator("#join-room").click();
  await grace.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  await ada.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  await ada.locator("#chat-log").getByText("Grace: Peer-Chat verbunden").waitFor();
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);
  await grace.locator("#receive-quality-profile-live").selectOption("low");
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);

  await ada.locator("#chat-message").fill("Hallo über den DataChannel");
  await ada.locator("#chat-form button").click();
  await grace.locator("#chat-log").getByText("Hallo über den DataChannel").waitFor();

  await ada.locator("#toggle-camera").click();
  await ada.locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Kamera").waitFor();
  await Promise.all([ada, grace].map((page) => page.locator("#sframe-status", { hasText: "active" }).waitFor()));
  await grace.waitForFunction(() => [...document.querySelectorAll("video:not([muted])")]
    .some((video) => video.readyState >= 2 && video.videoWidth > 0));
  await ada.waitForFunction(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__senderParameterEvents.some((event) => cameraTrackIds.has(event.trackId)
      && event.succeeded === true
      && event.encodings.some((encoding) => encoding.active === true
        && encoding.maxBitrate === 120_000
        && encoding.maxFramerate === 6
        && encoding.scaleResolutionDownBy === 4));
  });
  await grace.locator("#receive-quality-profile-live").selectOption("audio-only");
  await grace.waitForFunction(() => [...document.querySelectorAll(".remote-media video")]
    .some((video) => video.srcObject?.getVideoTracks().some((track) => !track.enabled)));
  await ada.waitForFunction(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__senderParameterEvents.some((event) => cameraTrackIds.has(event.trackId)
      && event.succeeded === true
      && event.encodings.some((encoding) => encoding.active === false));
  });
  await ada.evaluate(() => { window.__senderParameterEvents = []; });
  await grace.locator("#receive-quality-profile-live").selectOption("auto");
  await grace.waitForFunction(() => [...document.querySelectorAll(".remote-media video")]
    .some((video) => video.srcObject?.getVideoTracks().some((track) => track.enabled)));
  await ada.waitForFunction(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__senderParameterEvents.some((event) => cameraTrackIds.has(event.trackId)
      && event.succeeded === true
      && event.encodings.some((encoding) => encoding.active === true));
  });
  await ada.evaluate(() => { window.__senderParameterEvents = []; });
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);

  const cameraCapture = await ada.evaluate(() => window.__captureConstraints
    .find((event) => event.method === "getUserMedia" && event.constraints.video));
  assert.deepEqual(cameraCapture.constraints, {
    video: {
      frameRate: { ideal: 5, max: 5 },
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 360 },
    },
    audio: false,
  });
  await ada.locator(".nav-item", { hasText: "Einstellungen" }).click();
  await ada.locator("#camera-applied-settings").waitFor({ state: "visible" });
  assert.match(await ada.locator("#camera-applied-settings").textContent(), /^\d+(?:\.\d+)? × \d+(?:\.\d+)? · \d+(?:\.\d+)? FPS$/);
  await ada.locator("#camera-resolution").selectOption("240p");
  await ada.locator("#camera-frame-rate").selectOption({ label: "2 FPS" });
  await ada.waitForFunction(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__appliedTrackConstraints.filter((event) => cameraTrackIds.has(event.trackId)).length >= 2;
  });
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), ["getUserMedia"]);
  const cameraApplied = await ada.evaluate(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__appliedTrackConstraints.filter((event) => cameraTrackIds.has(event.trackId)).at(-1);
  });
  assert.deepEqual(cameraApplied.constraints, {
    frameRate: { ideal: 2, max: 2 },
    width: { ideal: 426, max: 426 },
    height: { ideal: 240, max: 240 },
  });
  assert.ok(cameraApplied.settings.width <= 426);
  assert.ok(cameraApplied.settings.height <= 240);
  assert.ok(cameraApplied.settings.frameRate <= 2);
  await ada.locator("#camera-resolution").selectOption("360p");
  await ada.locator("#camera-frame-rate").selectOption({ label: "15 FPS" });
  await ada.waitForFunction(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__appliedTrackConstraints.some((event) => cameraTrackIds.has(event.trackId)
      && event.constraints.frameRate?.max === 15
      && event.constraints.width?.max === 640);
  });
  await ada.locator(".nav-item", { hasText: "Live" }).click();

  await ada.locator("#toggle-microphone").click();
  await ada.locator("#toggle-microphone", { hasText: "Mikrofon stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Mikrofon").waitFor();
  const microphoneCapture = await ada.evaluate(() => window.__captureConstraints
    .find((event) => event.method === "getUserMedia" && event.constraints.audio && event.constraints.video === false));
  assert.deepEqual(microphoneCapture.constraints, {
    audio: {
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  await ada.locator(".nav-item", { hasText: "Einstellungen" }).click();
  assert.notEqual(await ada.locator("#microphone-applied-settings").textContent(), "Nicht aktiv");
  await ada.locator("#audio-quality-profile").selectOption("speech-low");
  await ada.waitForFunction(() => {
    const microphoneTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "microphone").map(([trackId]) => trackId));
    return window.__appliedTrackConstraints.some((event) => microphoneTrackIds.has(event.trackId)
      && event.constraints.sampleRate?.ideal === 24_000);
  });
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), ["getUserMedia", "getUserMedia"]);
  assert.equal(await ada.locator("#media-strategy-preset").inputValue(), "custom");
  await ada.locator(".nav-item", { hasText: "Live" }).click();

  await ada.evaluate(() => { window.__forceLowBitrateLink = true; });
  await ada.locator(".nav-item", { hasText: "Chat" }).click();
  await ada.locator(".persistent-media-dock").waitFor();
  await ada.locator("#toggle-screen").click();
  await ada.locator("#toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Bildschirm").first().waitFor();
  await ada.locator(".nav-item", { hasText: "Einstellungen" }).click();
  const screenCapture = await ada.evaluate(() => window.__captureConstraints
    .find((event) => event.method === "getDisplayMedia"));
  assert.deepEqual(screenCapture.constraints, {
    video: {
      frameRate: { ideal: 10, max: 10 },
      width: { ideal: 854, max: 854 },
      height: { ideal: 480, max: 480 },
    },
    audio: false,
  });
  assert.match(await ada.locator("#screen-applied-settings").textContent(), /^\d+(?:\.\d+)? × \d+(?:\.\d+)? · \d+(?:\.\d+)? FPS$/);
  await ada.locator("#screen-resolution").selectOption("360p");
  await ada.locator("#screen-frame-rate").selectOption({ label: "5 FPS" });
  await ada.waitForFunction(() => {
    const screenTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "screen").map(([trackId]) => trackId));
    return window.__appliedTrackConstraints.filter((event) => screenTrackIds.has(event.trackId)).length >= 2;
  });
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), ["getUserMedia", "getUserMedia", "getDisplayMedia"]);
  const screenApplied = await ada.evaluate(() => {
    const screenTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "screen").map(([trackId]) => trackId));
    return window.__appliedTrackConstraints.filter((event) => screenTrackIds.has(event.trackId)).at(-1);
  });
  assert.ok(screenApplied.settings.width <= 640);
  assert.ok(screenApplied.settings.height <= 360);
  assert.ok(screenApplied.settings.frameRate <= 5);
  await ada.locator("#link-quality", { hasText: "constrained" }).waitFor({ timeout: 5_000 });
  await ada.waitForFunction(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__senderParameterEvents.some((event) => cameraTrackIds.has(event.trackId)
      && event.succeeded === true
      && event.encodings.some((encoding) => encoding.active === true
        && encoding.maxBitrate === 288_000
        && encoding.maxFramerate === 12
        && encoding.scaleResolutionDownBy === 4));
  });
  assert.equal(await ada.evaluate(() => {
    const cameraTrackIds = new Set(Object.entries(window.__localTrackSources)
      .filter(([, source]) => source === "camera").map(([trackId]) => trackId));
    return window.__senderParameterEvents.some((event) => cameraTrackIds.has(event.trackId)
      && event.encodings.some((encoding) => encoding.active === false));
  }), false);
  const remoteCamera = grace.locator(".remote-media", { hasText: "Ada · Kamera" }).locator("video");
  const continuityDeadline = Date.now() + cameraContinuityWindowMs;
  let cameraFrames = await remoteCamera.evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);
  let continuitySamples = 0;
  while (Date.now() < continuityDeadline) {
    await grace.waitForTimeout(Math.min(5_000, Math.max(1_000, continuityDeadline - Date.now())));
    const nextFrames = await remoteCamera.evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);
    assert.ok(nextFrames > cameraFrames, `remote camera stalled at ${cameraFrames} rendered frames`);
    cameraFrames = nextFrames;
    continuitySamples += 1;
  }
  assert.ok(continuitySamples >= 1);
  assert.deepEqual(await ada.evaluate(() => Object.entries(window.__localTrackSources)
    .filter(([, source]) => source === "camera" || source === "screen")
    .map(([trackId, source]) => ({
      source,
      readyState: window.__localTracks[trackId]?.readyState,
      enabled: window.__localTracks[trackId]?.enabled,
    })).sort((left, right) => left.source.localeCompare(right.source))), [
    { source: "camera", readyState: "live", enabled: true },
    { source: "screen", readyState: "live", enabled: true },
  ]);
  await ada.locator("#media-strategy-preset").selectOption("presentation");
  await ada.waitForFunction(() => {
    const sources = Object.entries(window.__localTrackSources);
    const trackIds = (source) => new Set(sources.filter(([, value]) => value === source).map(([trackId]) => trackId));
    const microphone = trackIds("microphone");
    const camera = trackIds("camera");
    const screen = trackIds("screen");
    const succeededWith = (ids, priority) => window.__senderParameterEvents.some((event) => event.succeeded === true
      && ids.has(event.trackId) && event.encodings.some((encoding) => encoding.priority === priority));
    return succeededWith(screen, "high") && succeededWith(microphone, "medium") && succeededWith(camera, "low");
  });
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), ["getUserMedia", "getUserMedia", "getDisplayMedia"]);
  await ada.locator("#mesh-analysis-navigation").click();
  await ada.locator("#mesh-node-count", { hasText: "2" }).waitFor();
  await ada.locator("#mesh-edge-count", { hasText: "1" }).waitFor({ timeout: 8_000 });
  await ada.locator(".mesh-edge .edge-label").filter({ hasText: /(?:kbit|Mbit)\/s/ }).waitFor();
  await ada.locator('.mesh-node[aria-label^="Grace,"] > circle').first().click();
  await ada.locator("#mesh-selected-node", { hasText: "Grace" }).waitFor();
  for (const label of ["Audio", "Kamera / Video", "Bildschirmteilen"]) {
    const row = ada.locator(".traffic-detail dl > div", { hasText: label });
    await row.waitFor();
    assert.match(await row.textContent(), /(?:kbit|Mbit)\/s/);
    assert.doesNotMatch(await row.textContent(), /nicht messbar/);
  }
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), ["getUserMedia", "getUserMedia", "getDisplayMedia"]);
  await ada.locator(".persistent-media-dock #toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).click();
  await ada.locator(".nav-item", { hasText: "Live" }).click();

  assert.deepEqual(pageErrors, []);
  await ada.locator("#leave-room").click();
  await grace.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
});

test("Chromium keeps screen audio default-off and revokes opted-in audio without stopping video", { timeout: 30_000 }, async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed; run: npx playwright install chromium");
    return;
  }
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
      mediaE2eeMode: "disabled",
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });
  const browserContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  await browserContext.addInitScript(() => {
    window.__displayCaptureCalls = [];
    window.__lastDisplayStream = null;
    window.__lastDisplayVideoTrack = null;
    window.__lastDisplayAudioTrack = null;
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      window.__displayCaptureCalls.push(JSON.parse(JSON.stringify(constraints || {})));
      const stream = await original(constraints);
      window.__lastDisplayStream = stream;
      window.__lastDisplayVideoTrack = stream.getVideoTracks()[0] || null;
      window.__lastDisplayAudioTrack = stream.getAudioTracks()[0] || null;
      return stream;
    };
  });
  context.after(async () => {
    await browserContext.close();
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const page = await browserContext.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(origin);
  await page.locator(".nav-item", { hasText: "Einstellungen" }).click();
  await page.locator("#screen-audio-enabled").waitFor();
  assert.equal(await page.locator("#screen-audio-enabled").isChecked(), false);
  assert.equal(await page.locator("#screen-audio-status").textContent(), "aus");
  assert.deepEqual(await page.evaluate(() => window.__displayCaptureCalls), []);

  await page.locator(".nav-item", { hasText: "Räume" }).click();
  await page.locator("#display-name").fill("Echo-Test");
  await page.locator("#create-room").click();
  await page.waitForFunction(() => document.querySelector("#room-id").value.startsWith("room-"));
  await page.locator("#join-room").click();
  await page.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();

  await page.locator("#toggle-screen").click();
  await page.locator("#toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor();
  assert.equal(await page.evaluate(() => window.__lastDisplayStream.getAudioTracks().length), 0);
  assert.equal(await page.evaluate(() => window.__lastDisplayVideoTrack.readyState), "live");
  assert.equal(await page.evaluate(() => window.__displayCaptureCalls[0].audio), false);
  await page.locator("#toggle-screen").click();

  await page.locator(".nav-item", { hasText: "Einstellungen" }).click();
  await page.locator("#screen-audio-enabled").check();
  await page.locator("#screen-audio-status", { hasText: "beim nächsten Teilen angefordert" }).waitFor();
  assert.equal(await page.evaluate(() => window.__displayCaptureCalls.length), 1);

  await page.locator(".nav-item", { hasText: "Live" }).click();
  await page.locator("#toggle-screen").click();
  await page.locator("#toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor();
  await page.locator(".nav-item", { hasText: "Einstellungen" }).click();
  await page.locator("#screen-audio-status", { hasText: "aktiv" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__displayCaptureCalls[1].audio), { restrictOwnAudio: true });
  assert.equal(await page.evaluate(() => window.__lastDisplayStream.getAudioTracks().length), 1);

  await page.locator("#screen-audio-enabled").uncheck();
  await page.locator("#screen-audio-status", { hasText: "aus" }).waitFor();
  assert.equal(await page.evaluate(() => window.__displayCaptureCalls.length), 2);
  assert.equal(await page.evaluate(() => window.__lastDisplayAudioTrack.readyState), "ended");
  assert.equal(await page.evaluate(() => window.__lastDisplayStream.getAudioTracks().length), 0);
  assert.equal(await page.evaluate(() => window.__lastDisplayVideoTrack.readyState), "live");
  await page.locator(".persistent-media-dock #toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor();
  assert.deepEqual(pageErrors, []);
});

test("required SFrame drops media instead of downgrading an unsupported Chromium context", { timeout: 30_000 }, async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed; run: npx playwright install chromium");
    return;
  }
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
      mediaE2eeMode: "required",
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const browserContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  await browserContext.addInitScript(() => {
    Object.defineProperty(globalThis, "RTCRtpScriptTransform", { configurable: true, value: undefined });
    window.__captureCalls = [];
    window.__addTrackCalls = 0;
    const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => {
      window.__captureCalls.push("getUserMedia");
      return originalCapture(...args);
    };
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class ObservedPeerConnection extends NativePeerConnection {
      addTrack(...args) {
        window.__addTrackCalls += 1;
        return super.addTrack(...args);
      }
    };
  });
  context.after(async () => {
    await browserContext.close();
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const ada = await browserContext.newPage();
  const grace = await browserContext.newPage();
  const pageErrors = [];
  for (const page of [ada, grace]) page.on("pageerror", (error) => pageErrors.push(error.message));
  await ada.goto(origin);
  await ada.locator("#display-name").fill("Ada");
  await ada.locator("#create-room").click();
  await ada.waitForFunction(() => document.querySelector("#room-id").value.startsWith("room-"));
  const roomId = await ada.locator("#room-id").inputValue();
  await ada.locator("#join-room").click();
  await grace.goto(`${origin}/?room=${roomId}`);
  await grace.locator("#display-name").fill("Grace");
  await grace.locator("#join-room").click();
  await Promise.all([ada, grace].map((page) => page.locator("#participant-count", { hasText: "2 / 20" }).waitFor()));
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);
  await ada.locator("#toggle-camera").click();
  await ada.locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
  await Promise.all([ada, grace].map((page) => page.locator("#sframe-status", { hasText: "unsupported" }).waitFor()));
  await ada.waitForTimeout(300);
  assert.equal(await ada.evaluate(() => window.__addTrackCalls), 0);
  assert.equal(await grace.locator(".media-label", { hasText: "Ada · Kamera" }).count(), 0);
  assert.deepEqual(pageErrors, []);
});

test("two independent Chromium devices join Pair Dev while device three is rejected", { timeout: 30_000 }, async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed; run: npx playwright install chromium");
    return;
  }
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });
  const contexts = await Promise.all([
    browser.newContext({ permissions: ["camera", "microphone"] }),
    browser.newContext({ permissions: ["camera", "microphone"] }),
    browser.newContext({ permissions: ["camera", "microphone"] }),
  ]);
  context.after(async () => {
    for (const browserContext of contexts) await browserContext.close();
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });
  for (const browserContext of contexts) {
    await browserContext.addInitScript(() => {
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
  }
  const owner = await contexts[0].newPage();
  const peer = await contexts[1].newPage();
  const overflow = await contexts[2].newPage();
  await owner.goto(origin);
  await owner.locator("#display-name").fill("Ada");
  await owner.locator("#create-pair").click();
  await owner.waitForFunction(() => document.querySelector("#room-id").value.startsWith("pair-"));
  const roomId = await owner.locator("#room-id").inputValue();
  await owner.locator("#join-room").click();
  await owner.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();

  await peer.goto(`${origin}/?room=${roomId}&mode=pair`);
  await peer.locator("#display-name").fill("Grace");
  await peer.locator("#join-room").click();
  await peer.locator("#participant-count", { hasText: "2 / 2" }).waitFor();
  await owner.locator("#participant-count", { hasText: "2 / 2" }).waitFor();
  assert.deepEqual(await owner.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(await peer.evaluate(() => window.__captureCalls), []);

  await owner.locator("#overlay-path-status", { hasText: "Schlüsselkanal: bereit" }).waitFor({ timeout: 5_000 });
  await owner.locator(".nav-item", { hasText: "Chat" }).click();
  await owner.locator(".persistent-media-dock #toggle-screen").click();
  await owner.locator(".persistent-media-dock #toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor();
  await peer.locator(".media-label").getByText("Ada · Bildschirm").first().waitFor();
  await owner.locator(".nav-item", { hasText: "Räume" }).click();
  await owner.locator(".persistent-media-dock #toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).click();
  assert.deepEqual(await owner.evaluate(() => window.__captureCalls), ["getDisplayMedia"]);
  await owner.locator(".nav-item", { hasText: "Live" }).click();

  await owner.locator("#chat-message").fill("Pair verbunden");
  await owner.locator("#chat-form button").click();
  await peer.locator("#chat-log").getByText("Pair verbunden").waitFor();

  let automaticDownloads = 0;
  peer.on("download", () => { automaticDownloads += 1; });
  await owner.locator("#artifact-file").setInputFiles({
    name: "pair-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("opaque artifact ".repeat(1600)),
  });
  await owner.locator("#send-artifact").waitFor({ state: "visible" });
  await owner.locator("#overlay-path-status", { hasText: "Schlüsselkanal: bereit" }).waitFor({ timeout: 5_000 });
  await owner.locator("#send-artifact").click();
  await owner.locator("#artifact-status", { hasText: "Verschlüsselt" }).waitFor({ timeout: 5_000 });
  await peer.locator("[data-received-artifact]", { hasText: "pair-note.txt" }).waitFor({ timeout: 5_000 });
  assert.equal(automaticDownloads, 0);
  const downloadPromise = peer.waitForEvent("download");
  await peer.locator("[data-received-artifact] button").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "pair-note.txt");

  await overflow.goto(`${origin}/?room=${roomId}&mode=pair`);
  await overflow.locator("#display-name").fill("Linus");
  await overflow.locator("#join-room").click();
  await overflow.locator("#app-error", { hasText: "room_full" }).waitFor();
  assert.deepEqual(await overflow.evaluate(() => window.__captureCalls), []);

  await peer.locator("#leave-room").click();
  await owner.locator("#participant-count", { hasText: "1 / 2" }).waitFor();
});

test("six Chromium peers use consented video relay, adaptive sender tiers and one inactive mosaic", { timeout: 60_000 }, async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed; run: npx playwright install chromium");
    return;
  }
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 240,
      pairWorkspaceEnabled: false,
      activeSpeakerLimit: 2,
      peerMediaRelayEnabled: true,
      peerMediaRelayMinParticipants: 6,
      peerMediaRelayMaxChildren: 3,
      peerMediaRelayMaxHops: 3,
      mediaE2eeMode: "disabled",
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const browserContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  await browserContext.addInitScript(() => {
    window.__captureCalls = [];
    window.__localTrackIds = [];
    window.__addTrackEvents = [];
    window.__senderParameterEvents = [];
    const devices = navigator.mediaDevices;
    for (const method of ["getUserMedia", "getDisplayMedia"]) {
      const original = devices[method]?.bind(devices);
      if (!original) continue;
      devices[method] = async (...args) => {
        window.__captureCalls.push(method);
        const stream = await original(...args);
        for (const track of stream.getTracks()) window.__localTrackIds.push(track.id);
        return stream;
      };
    }
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class ObservedPeerConnection extends NativePeerConnection {
      addTrack(track, ...streams) {
        window.__addTrackEvents.push({ trackId: track.id, kind: track.kind });
        return super.addTrack(track, ...streams);
      }
    };
    const originalSetParameters = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function observedSetParameters(parameters) {
      window.__senderParameterEvents.push({
        trackId: this.track?.id || "",
        encodings: parameters.encodings.map((encoding) => ({
          active: encoding.active,
          maxBitrate: encoding.maxBitrate,
          maxFramerate: encoding.maxFramerate,
          scaleResolutionDownBy: encoding.scaleResolutionDownBy,
        })),
      });
      return originalSetParameters.call(this, parameters);
    };
  });
  context.after(async () => {
    await browserContext.close();
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });

  const names = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Katherine"];
  const pages = await Promise.all(names.map(() => browserContext.newPage()));
  const pageErrors = [];
  for (const page of pages) page.on("pageerror", (error) => pageErrors.push(error.message));
  await pages[0].goto(origin);
  await pages[0].locator("#display-name").fill(names[0]);
  await pages[0].locator("#create-room").click();
  await pages[0].waitForFunction(() => document.querySelector("#room-id").value.startsWith("room-"));
  const roomId = await pages[0].locator("#room-id").inputValue();
  await pages[0].locator("#join-room").click();
  for (let index = 1; index < pages.length; index += 1) {
    await pages[index].goto(`${origin}/?room=${roomId}`);
    await pages[index].locator("#display-name").fill(names[index]);
    await pages[index].locator("#join-room").click();
  }
  await Promise.all(pages.map((page) => page.locator("#participant-count", { hasText: "6 / 20" }).waitFor()));
  for (const page of pages) assert.deepEqual(await page.evaluate(() => window.__captureCalls), []);
  await pages[0].locator("#relay-consent").check();
  await pages[1].locator("#relay-consent").check();
  await Promise.all(pages.map((page) => page.locator("#topology-status", { hasText: "trusted_peer_relay" }).waitFor()));
  for (const page of pages) assert.deepEqual(await page.evaluate(() => window.__captureCalls), []);

  for (const page of pages) {
    await page.locator("#toggle-camera").click();
    await page.locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
  }
  await pages[0].waitForTimeout(3_000);
  await pages[0].locator("#mesh-analysis-navigation").click();
  await pages[0].locator("#mesh-node-count", { hasText: "6" }).waitFor();
  assert.ok(await pages[0].locator(".mesh-edge.trusted-relay").count() > 0);
  await pages[0].locator(".mesh-edge .edge-label").filter({ hasText: /(?:kbit|Mbit)\/s/ }).first().waitFor({ timeout: 8_000 });
  await pages[0].locator('.mesh-node[aria-label^="Grace,"] > circle').first().click();
  await pages[0].locator("#mesh-selected-node", { hasText: "Grace" }).waitFor();
  assert.equal(await pages[0].evaluate(() => window.__captureCalls.length), 1);
  await pages[0].locator(".nav-item", { hasText: "Live" }).click();
  await pages[0].waitForFunction(() => {
    const focused = document.querySelectorAll(".remote-media").length;
    const mosaicLabel = document.querySelector("#inactive-mosaic .media-label")?.textContent || "";
    return focused + Number(/(\d+) Vorschauen/.exec(mosaicLabel)?.[1] || 0) === 5;
  });
  for (let index = 0; index < pages.length; index += 1) {
    const focused = await pages[index].locator(".remote-media").count();
    const mosaic = pages[index].locator("#inactive-mosaic .media-label");
    const mosaicLabel = await mosaic.count() ? await mosaic.textContent() : "";
    const mosaicked = Number(/(\d+) Vorschauen/.exec(mosaicLabel || "")?.[1] || 0);
    assert.equal(focused + mosaicked, 5, `page ${names[index]} received ${focused + mosaicked} remote cameras`);
  }
  await pages[0].locator("#inactive-mosaic").waitFor();
  assert.equal(await pages[0].locator("#inactive-mosaic canvas").count(), 1);

  await pages[2].locator("#toggle-microphone").click();
  await pages[2].locator("#toggle-microphone", { hasText: "Mikrofon stoppen" }).waitFor();
  await pages[0].locator("#active-speakers", { hasText: "Linus" }).waitFor();

  const publisherFanout = await pages[0].evaluate(() => {
    const local = new Set(window.__localTrackIds);
    return window.__addTrackEvents.filter((event) => event.kind === "video" && local.has(event.trackId)).length;
  });
  assert.ok(publisherFanout >= 1 && publisherFanout <= 3, `publisher fanout was ${publisherFanout}, expected 1..3`);
  const forwardedByConsentingPeer = await pages[1].evaluate(() => {
    const local = new Set(window.__localTrackIds);
    return window.__addTrackEvents.some((event) => event.kind === "video" && !local.has(event.trackId));
  });
  assert.equal(forwardedByConsentingPeer, true);

  const topologyBeforeRevocation = await pages[0].locator("#topology-status").textContent();
  await pages[0].locator("#relay-consent").uncheck();
  await pages[0].waitForFunction((previous) => {
    const current = document.querySelector("#topology-status")?.textContent || "";
    return current.includes("trusted_peer_relay") && current !== previous;
  }, topologyBeforeRevocation);

  await pages[0].locator("#optimization-mode").selectOption("data-saver");
  await pages[0].waitForFunction(() => {
    const local = new Set(window.__localTrackIds);
    return window.__senderParameterEvents.some((event) => local.has(event.trackId)
      && event.encodings.some((encoding) => encoding.maxBitrate && encoding.maxBitrate <= 420_000));
  });
  assert.equal(await pages[0].evaluate(() => window.__captureCalls.length), 1);

  await pages[5].locator("#leave-room").click();
  await pages[0].locator("#participant-count", { hasText: "5 / 20" }).waitFor();
  await pages[0].locator("#topology-status", { hasText: "adaptive_mesh" }).waitFor();
  assert.deepEqual(pageErrors, []);
});

test("two Firefox peers retain direct adaptive mesh, SFrame, chat and camera", { timeout: 30_000 }, async (context) => {
  try {
    await fs.access(firefox.executablePath());
  } catch {
    context.skip("Playwright Firefox is not installed; run: npx playwright install firefox");
    return;
  }
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
      mediaE2eeMode: "required",
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
    },
  });
  const browserContext = await browser.newContext();
  await browserContext.addInitScript(() => {
    window.__captureCalls = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => {
      window.__captureCalls.push("getUserMedia");
      return original(...args);
    };
  });
  context.after(async () => {
    await browserContext.close();
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const ada = await browserContext.newPage();
  const grace = await browserContext.newPage();
  const pageErrors = [];
  for (const page of [ada, grace]) page.on("pageerror", (error) => pageErrors.push(error.message));
  await ada.goto(origin);
  await ada.locator("#display-name").fill("Ada");
  await ada.locator("#create-room").click();
  await ada.waitForFunction(() => document.querySelector("#room-id").value.startsWith("room-"));
  const roomId = await ada.locator("#room-id").inputValue();
  await ada.locator("#join-room").click();
  await grace.goto(`${origin}/?room=${roomId}`);
  await grace.locator("#display-name").fill("Grace");
  await grace.locator("#join-room").click();
  await Promise.all([ada, grace].map((page) => page.locator("#participant-count", { hasText: "2 / 20" }).waitFor()));
  assert.deepEqual(await ada.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);
  await grace.locator("#receive-quality-profile-live").selectOption("low");
  assert.equal(await grace.locator("#receive-quality-profile-live").inputValue(), "low");
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);
  await ada.locator("#chat-message").fill("Firefox DataChannel");
  await ada.locator("#chat-form button").click();
  await grace.locator("#chat-log").getByText("Firefox DataChannel").waitFor();
  await ada.locator("#optimization-mode").selectOption("data-saver");
  await ada.locator("#toggle-camera").click();
  await ada.locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Kamera").waitFor();
  await Promise.all([ada, grace].map((page) => page.locator("#sframe-status", { hasText: "active" }).waitFor()));
  await grace.waitForFunction(() => [...document.querySelectorAll("video:not([muted])")]
    .some((video) => video.readyState >= 2 && video.videoWidth > 0));
  await grace.locator("#topology-status", { hasText: "adaptive_mesh" }).waitFor();
  await grace.locator("#mesh-analysis-navigation").click();
  await grace.locator("#mesh-node-count", { hasText: "2" }).waitFor();
  await grace.locator("#mesh-edge-count", { hasText: "1" }).waitFor({ timeout: 8_000 });
  await grace.locator('.mesh-node[aria-label^="Ada,"] > circle').first().click();
  await grace.locator("#mesh-selected-node", { hasText: "Ada" }).waitFor();
  const firefoxVideoRate = grace.locator(".traffic-detail dl > div", { hasText: "Kamera / Video" });
  assert.match(await firefoxVideoRate.textContent(), /(?:kbit|Mbit)\/s/);
  assert.doesNotMatch(await firefoxVideoRate.textContent(), /nicht messbar/);
  assert.deepEqual(await grace.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(pageErrors, []);
});
