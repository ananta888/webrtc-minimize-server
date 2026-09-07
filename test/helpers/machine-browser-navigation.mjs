// Private fixture bootstrap only: never wrap room creation, join or task work.
export async function navigateFixture(page, url, ready, { clock = () => performance.now(), budgetMs = 30000 } = {}) {
  const deadline = clock() + budgetMs;
  const remaining = () => {
    const value = deadline - clock();
    if (value <= 0) throw new Error("test_navigation_deadline");
    return value;
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
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
        await page.waitForFunction(ready, null, { timeout: remaining() });
        remaining();
      })()]);
      return attempt;
    } catch (error) {
      if (attempt === 2 || error !== changed && !/\bnet::ERR_NETWORK_CHANGED\b/.test(String(error.message))) throw error;
      remaining();
    } finally {
      current = false;
      page.off("requestfailed", failed);
    }
  }
}
