// Private fixture bootstrap only: never wrap room creation, join or task work.
import { waitFixtureValue } from "./machine-browser-wait.mjs";

export async function navigateFixture(page, url, ready, {
  clock = () => performance.now(), budgetMs = 30000,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  wait = waitFixtureValue,
} = {}) {
  const deadline = clock() + budgetMs;
  const remaining = () => {
    const value = deadline - clock();
    if (value <= 0) throw new Error("test_navigation_deadline");
    return value;
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const changed = new Error("test_navigation_network_changed");
    let rejectChange, current = true;
    const interrupted = new Promise((_, reject) => { rejectChange = reject; });
    const failed = request => {
      if (request.failure()?.errorText === "net::ERR_NETWORK_CHANGED") rejectChange(changed);
    };
    page.on("requestfailed", failed);
    try {
      await Promise.race([interrupted, (async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });
        if (!current) throw changed;
        await wait(page, ready, null, { timeout: remaining(), signal: controller.signal });
        remaining();
      })()]);
      return attempt;
    } catch (error) {
      if (attempt === 2 || error !== changed && !/\bnet::ERR_NETWORK_CHANGED\b/.test(String(error.message))) throw error;
      // Docker route notifications may arrive in a burst. Do not spend the
      // only retry immediately on that same burst; never extend the deadline.
      await pause(Math.min(500, remaining()));
      remaining();
    } finally {
      current = false;
      controller.abort();
      page.off("requestfailed", failed);
    }
  }
}
