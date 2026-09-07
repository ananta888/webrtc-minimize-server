import { avatarAbsent, decodedAvatar } from "./machine-avatar-coexistence.mjs";
import { waitFixtureValue } from "./machine-browser-wait.mjs";

// Fixed read-only remote observations. No source/Hub control operations, grants,
// image bytes, URLs, scripts or arbitrary arguments pass through the stdio port.
export async function observeAvatarCommand(command, page) {
  if (command !== "avatar" && command !== "avatar_absent") return null;
  await page.locator(".nav-item").filter({ hasText: /^Live/ }).click();
  if (command === "avatar_absent") {
    await waitFixtureValue(page, avatarAbsent, null, { timeout: 4000 });
    return { avatar_absent: true };
  }
  const indicators = new Set();
  try { await waitFixtureValue(page, decodedAvatar, null, { timeout: 6000, accept: value => {
    if (!Array.isArray(value?.center) || value.white <= 100 || value.center[1] <= 170
      || value.center[0] <= 60 || value.center[0] >= 160) return false;
    indicators.add(value.bright);
    return indicators.size >= 2;
  } }); } catch {
    const error = new Error("avatar_not_moving");
    error.observation = await page.evaluate(() => ({
      videos: [...document.querySelectorAll("video")].map(v => ({ width: v.videoWidth, height: v.videoHeight,
        ready: v.readyState, attached: Boolean(v.srcObject) })),
      captureCalls: window.__captures, transformErrors: window.__transformErrors.length,
    }));
    error.observation.sample = await page.evaluate(decodedAvatar);
    throw error;
  }
  return { moving_avatar: true };
}
