import fs from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { createAppServer } from "../src/server.js";

test("two Chromium pages negotiate chat, camera, microphone and screen", { timeout: 30_000 }, async (context) => {
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
    for (const method of ["getUserMedia", "getDisplayMedia"]) {
      const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
      navigator.mediaDevices[method] = (...args) => {
        window.__captureCalls.push(method);
        return original(...args);
      };
    }
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

  await ada.locator("#chat-message").fill("Hallo über den DataChannel");
  await ada.locator("#chat-form button").click();
  await grace.locator("#chat-log").getByText("Hallo über den DataChannel").waitFor();

  await ada.locator("#toggle-camera").click();
  await ada.locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Kamera").waitFor();

  await ada.locator("#toggle-microphone").click();
  await ada.locator("#toggle-microphone", { hasText: "Mikrofon stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Mikrofon").waitFor();

  await ada.locator("#toggle-screen").click();
  await ada.locator("#toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor();
  await grace.locator(".media-label").getByText("Ada · Bildschirm").first().waitFor();

  assert.deepEqual(pageErrors, []);
  await ada.locator("#leave-room").click();
  await grace.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
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
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
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

  await owner.locator("#chat-message").fill("Pair verbunden");
  await owner.locator("#chat-form button").click();
  await peer.locator("#chat-log").getByText("Pair verbunden").waitFor();

  await overflow.goto(`${origin}/?room=${roomId}&mode=pair`);
  await overflow.locator("#display-name").fill("Linus");
  await overflow.locator("#join-room").click();
  await overflow.locator("#app-error", { hasText: "room_full" }).waitFor();
  assert.deepEqual(await overflow.evaluate(() => window.__captureCalls), []);

  await peer.locator("#leave-room").click();
  await owner.locator("#participant-count", { hasText: "1 / 2" }).waitFor();
});
