import { avatarAbsent, decodedAvatar } from "./machine-avatar-coexistence.mjs";
import { waitFixtureValue } from "./machine-browser-wait.mjs";

// Fixed read-only remote observations. No source/Hub control operations, grants,
// image bytes, URLs, scripts or arbitrary arguments pass through the stdio port.
export async function observeAvatarCommand(command, page) {
  if (!["avatar", "avatar_absent", "avatar_image_red", "avatar_image_blue"].includes(command)) return null;
  await page.locator(".nav-item").filter({ hasText: /^Live/ }).click();
  if (command === "avatar_absent") {
    await waitFixtureValue(page, avatarAbsent, null, { timeout: 4000 });
    return { avatar_absent: true };
  }
  const indicators = new Set();
  try { await waitFixtureValue(page, decodedAvatar, null, { timeout: 6000, accept: value => {
    if (!Array.isArray(value?.center) || value.white <= 100) return false;
    const [red, green, blue] = value.center;
    const color = command === "avatar_image_red" ? red > 170 && green < 70 && blue < 70
      : command === "avatar_image_blue" ? blue > 170 && red < 70 && green < 70
      : green > 170 && red > 60 && red < 160;
    if (!color) return false;
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
  return command === "avatar" ? { moving_avatar: true }
    : { moving_avatar_image: command === "avatar_image_red" ? "red" : "blue" };
}
