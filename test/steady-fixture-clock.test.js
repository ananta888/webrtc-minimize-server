import assert from "node:assert/strict";
import test from "node:test";
import { steadyFixtureClock } from "./helpers/steady-fixture-clock.mjs";

test("synthetic protocol Date ignores later host corrections and restores after context cleanup", async t => {
  const originalDate = Date;
  await t.test("monotonic epoch", context => {
    let wall = 1800000000000, monotonic = 50, wallReads = 0;
    const sync = steadyFixtureClock(context, { wallNow: () => { wallReads++; return wall; }, monotonicNow: () => monotonic });
    assert.equal(Date.now(), wall); assert.equal(new Date().getTime(), wall);
    wall += 2531; monotonic += 1236.8; sync();
    assert.equal(Date.now(), 1800000001236); assert.equal(new Date().getTime(), Date.now());
    wall -= 100000; monotonic += 10; sync();
    assert.equal(Date.now(), 1800000001246); assert.equal(wallReads, 1);
    monotonic -= 1;
    assert.throws(sync, /invalid fixture monotonic/);
  });
  assert.strictEqual(Date, originalDate, "test scope restores the actual Date constructor");
});

test("steady protocol time advances while genuine async timers continue running", async t => {
  const origin = Date.now();
  steadyFixtureClock(t);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(Date.now() > origin);
});

test("invalid fixture clocks cannot install a Date mock", t => {
  const originalDate = Date;
  for (const value of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => steadyFixtureClock(t, { wallNow: () => value }));
    assert.strictEqual(Date, originalDate);
  }
});
