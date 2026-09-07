// Host-side bounded polling of synchronous JSON values. Firefox may expose an
// unresolved ZoneAwarePromise from page.waitForFunction as a truthy result.
// Never accept promise-shaped objects as readiness or change application globals.
export async function waitFixtureValue(page, predicate, arg, {
  timeout = 5000, accept = value => value === true, signal,
} = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30000) throw new Error("test_fixture_wait_budget");
  let active = true, timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new Error("test_fixture_wait_cancelled"));
    timer = setTimeout(() => reject(new Error("test_fixture_wait_deadline")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([stopped, (async () => {
      while (active && !signal?.aborted) {
        const value = await page.evaluate(predicate, arg);
        if (!active || signal?.aborted) break;
        if (value && typeof value === "object" && ("__zone_symbol__state" in value || typeof value.then === "function")) {
          throw new Error("test_fixture_wait_non_value");
        }
        if (accept(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("test_fixture_wait_cancelled");
    })()]);
  } finally {
    active = false; clearTimeout(timer); signal?.removeEventListener("abort", abort);
  }
}
