import assert from "node:assert/strict";

// Only for a node:test context's synthetic, in-process protocol fixtures.
// Real timers and sockets keep running. Date's constructor and Date.now share
// a stable epoch derived from monotonic elapsed time, not later host corrections.
// The test context restores Date after all of its cleanup hooks have finished.
export function steadyFixtureClock(t, {
  wallNow = Date.now, monotonicNow = () => performance.now(),
} = {}) {
  const wallStart = wallNow(), monotonicStart = monotonicNow();
  assert.ok(Number.isSafeInteger(wallStart) && wallStart > 0 && Number.isFinite(monotonicStart));
  t.mock.timers.enable({ apis: ["Date"], now: wallStart });
  let active = true, previous = monotonicStart;
  const synchronize = () => {
    if (!active) return;
    const current = monotonicNow();
    assert.ok(Number.isFinite(current) && current >= previous, "invalid fixture monotonic clock");
    previous = current;
    const epoch = wallStart + Math.floor(current - monotonicStart);
    assert.ok(Number.isSafeInteger(epoch), "invalid fixture epoch");
    t.mock.timers.setTime(epoch);
  };
  const timer = setInterval(synchronize, 5);
  t.after(() => { active = false; clearInterval(timer); });
  return synchronize;
}
