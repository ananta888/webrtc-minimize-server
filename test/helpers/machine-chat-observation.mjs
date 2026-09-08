// Failure snapshots only. No additional messages, authority or answer retries.
const unavailable = () => ({ available: false });
function closedSnapshot(value) {
  const keys = ["attempted", "queued", "send_failures", "answer_seen", "rendered"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))
    || !keys.slice(0, 3).every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 8)
    || value.queued + value.send_failures > value.attempted
    || typeof value.answer_seen !== "boolean" || typeof value.rendered !== "boolean"
    || value.rendered && !value.answer_seen) return unavailable();
  return { available: true, attempted: value.attempted, queued: value.queued,
    send_failures: value.send_failures, answer_seen: value.answer_seen, rendered: value.rendered };
}

async function snapshot(page, timers) {
  let timer;
  const reading = Promise.resolve().then(() => page.evaluate(() => window.__dialogObservation.chatStatus()))
    .then(closedSnapshot).catch(unavailable);
  try {
    return await Promise.race([reading, new Promise(resolve => {
      timer = timers.setTimeout(() => resolve(unavailable()), 1000);
    })]);
  } finally { timers.clearTimeout(timer); }
}

export async function observeDialogAnswer(page, timers = { setTimeout, clearTimeout }) {
  try {
    await page.waitForFunction(() => window.__dialogObservation.status().correlated, null, { timeout: 30000 });
  } catch (error) {
    if (error?.name !== "TimeoutError") throw error;
    return { correlated: false, chat_probe: await snapshot(page, timers) };
  }
  return page.evaluate(() => window.__dialogObservation.answer());
}
