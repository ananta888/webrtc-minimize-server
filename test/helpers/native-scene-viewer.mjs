import assert from "node:assert/strict";
import { waitFixtureValue } from "./machine-browser-wait.mjs";

export async function openSceneViewer(f) {
  const page = await f.context.newPage();
  await page.goto(`${f.origin}/?section=broadcast`);
  await page.locator("#broadcast-audience-directory > header").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator('section[aria-labelledby="own-broadcasts-heading"]')
    .getByRole("button", { name: "Zuschauen", exact: true }).click();
  await page.locator("#broadcast-player-start").click();
  return page;
}

export async function decodedScene(page, color, afterTime = 0) {
  await waitFixtureValue(page, ({ color, afterTime }) => {
    const video = document.querySelector('video[aria-label="Live-Broadcast"]');
    if (!video || video.readyState < 2 || video.videoWidth < 100 || video.currentTime <= afterTime
      || video.getVideoPlaybackQuality().totalVideoFrames < 3) return false;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.drawImage(video, Math.floor(video.videoWidth / 2), Math.floor(video.videoHeight / 2), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return color === "red" ? r > 150 && g < 90 && b < 90 : r < 90 && g < 90 && b < 90;
  }, { color, afterTime }, { timeout: 20_000 });
  const result = await page.evaluate(() => {
    const v = document.querySelector('video[aria-label="Live-Broadcast"]');
    return { time: v.currentTime, decodedFrames: v.getVideoPlaybackQuality().totalVideoFrames,
      width: v.videoWidth, height: v.videoHeight, captures: window.__sceneCaptures };
  });
  assert.equal(result.captures, 0);
  return result;
}

export async function sceneViewerObservation(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video[aria-label="Live-Broadcast"]');
    const publicCode = selector => {
      const candidate = document.querySelector(selector)?.textContent?.trim().split(".")[0];
      return typeof candidate === "string" && /^broadcast_[a-z_]{1,80}$/.test(candidate) ? candidate : null;
    };
    const errorCode = publicCode("#broadcast-open-error");
    const playerErrorCode = publicCode("app-broadcast-player .player-message[role=alert] span");
    if (!v) return { exists: false, errorCode, playerErrorCode };
    const c = document.createElement("canvas"); c.width = c.height = 1; const ctx = c.getContext("2d");
    let rgb = [];
    if (v.readyState >= 2) { ctx.drawImage(v, Math.floor(v.videoWidth / 2), Math.floor(v.videoHeight / 2), 1, 1, 0, 0, 1, 1); rgb = [...ctx.getImageData(0, 0, 1, 1).data]; }
    return { exists: true, errorCode, playerErrorCode, time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, ready: v.readyState,
      paused: v.paused, ended: v.ended, rgb, lifecycle: document.querySelector("app-broadcast-player [data-state]")?.getAttribute("data-state") };
  });
}

export async function decodedSceneTiles(page, colors, differentBlueFrom = null) {
  assert.equal(colors.length, 2);
  assert.ok(colors.every(color => ["red", "blue", "slate"].includes(color)));
  assert.ok(differentBlueFrom === null || Number.isInteger(differentBlueFrom) && differentBlueFrom >= 0 && differentBlueFrom <= 255);
  return waitFixtureValue(page, ({ colors, differentBlueFrom }) => {
    const v = document.querySelector('video[aria-label="Live-Broadcast"]');
    if (!v || v.readyState < 2 || v.videoWidth < 100 || v.getVideoPlaybackQuality().totalVideoFrames < 3) return null;
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const ctx = c.getContext("2d");
    const pixels = [.25, .75].map(x => {
      ctx.drawImage(v, Math.floor(v.videoWidth * x), Math.floor(v.videoHeight / 2), 1, 1, 0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    const matches = pixels.every(([r, g, b], i) => colors[i] === "red" ? r > 150 && g < 90 && b < 90
      : colors[i] === "blue" ? b > 150 && r < 90 && g < 90 : r < 90 && g < 90 && b < 90);
    return matches && (differentBlueFrom === null || Math.abs(pixels[1][2] - differentBlueFrom) > 15)
      ? { time: v.currentTime, decodedFrames: v.getVideoPlaybackQuality().totalVideoFrames, pixels } : null;
  }, { colors, differentBlueFrom }, { timeout: 20_000, accept: value => value !== null });
}
