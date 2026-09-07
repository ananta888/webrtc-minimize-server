import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { navigateFixture as navigate } from "./helpers/machine-browser-navigation.mjs";

// Navigation policy tests inject the wait port; its real JSON polling has its own tests.
const navigateFixture = (page, url, ready, options = {}) => navigate(page, url, ready,
  { wait: (target, ...args) => target.waitForFunction(...args), ...options });

function fixture() {
  const page = new EventEmitter();
  page.navigations = []; page.waits = [];
  page.goto = async (url, options) => { page.navigations.push({ url, options }); };
  page.waitForFunction = async (ready, arg, options) => { page.waits.push({ ready, arg, options }); };
  return page;
}
const ready = () => true, url = "https://synthetic.example.test";

test("navigation bootstrap has one shared deadline and does not retry success", async () => {
  const page = fixture(); let now = 0;
  const go = page.goto; page.goto = async (...args) => { await go(...args); now = 700; };
  assert.equal(await navigateFixture(page, url, ready, { clock: () => now, budgetMs: 1000 }), 1);
  assert.equal(page.navigations[0].options.timeout, 1000);
  assert.equal(page.waits[0].options.timeout, 300);
  assert.equal(page.waits[0].ready, ready);
  assert.equal(page.listenerCount("requestfailed"), 0);
});

test("only a precise navigation network-change error permits one retry", async () => {
  const page = fixture(), go = page.goto;
  page.goto = async (...args) => { await go(...args);
    if (page.navigations.length === 1) throw new Error("page.goto: net::ERR_NETWORK_CHANGED"); };
  assert.equal(await navigateFixture(page, url, ready), 2);
  assert.equal(page.navigations.length, 2); assert.equal(page.waits.length, 1);
  assert.equal(page.listenerCount("requestfailed"), 0);
});

test("failed bootstrap subresource interrupts readiness without repeating any room operation", async () => {
  const page = fixture(); let calls = 0, retire;
  page.waitForFunction = () => {
    if (++calls !== 1) return Promise.resolve();
    page.emit("requestfailed", { failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) });
    return new Promise((_, reject) => { retire = reject; });
  };
  assert.equal(await navigateFixture(page, url, ready), 2);
  retire(new Error("old page closed")); // Losing promise is handled, never an unhandled rejection.
  assert.equal(page.navigations.length, 2); assert.equal(page.listenerCount("requestfailed"), 0);
});

for (const message of ["HTTP 401", "policy_denied", "TimeoutError", "net::ERR_FAILED", "net::ERR_NETWORK_CHANGED_EXTRA"]) {
  test(`does not retry unrelated bootstrap failure: ${message}`, async () => {
    const page = fixture(), error = new Error(message);
    page.waitForFunction = async () => { throw error; };
    await assert.rejects(navigateFixture(page, url, ready), value => value === error);
    assert.equal(page.navigations.length, 1); assert.equal(page.listenerCount("requestfailed"), 0);
  });
}

test("a repeated network change terminates after exactly two attempts", async () => {
  const page = fixture(), go = page.goto;
  page.goto = async (...args) => { await go(...args); throw new Error("net::ERR_NETWORK_CHANGED"); };
  await assert.rejects(navigateFixture(page, url, ready), /ERR_NETWORK_CHANGED/);
  assert.equal(page.navigations.length, 2); assert.equal(page.listenerCount("requestfailed"), 0);
});

test("exhausted shared deadline cannot be extended by a network retry", async () => {
  const page = fixture(); let now = 0;
  page.goto = async () => { now = 1000; throw new Error("net::ERR_NETWORK_CHANGED"); };
  await assert.rejects(navigateFixture(page, url, ready, { clock: () => now, budgetMs: 1000 }), /deadline/);
  assert.equal(page.waits.length, 0); assert.equal(page.listenerCount("requestfailed"), 0);
});

test("network backoff consumes the existing deadline and occurs only once", async () => {
  const page = fixture(), go = page.goto, pauses = []; let now = 0;
  page.goto = async (...args) => { await go(...args);
    if (page.navigations.length === 1) { now += 100; throw new Error("net::ERR_NETWORK_CHANGED"); } };
  assert.equal(await navigateFixture(page, url, ready, { clock: () => now, budgetMs: 1000,
    pause: async ms => { pauses.push(ms); now += ms; } }), 2);
  assert.deepEqual(pauses, [500]); assert.equal(page.navigations[1].options.timeout, 400);
  assert.equal(page.listenerCount("requestfailed"), 0);
});
