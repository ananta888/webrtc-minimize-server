import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

for (const machineEngine of ["chromium", "firefox"]) {
  test(`${machineEngine} rejects a real accepted renewal observed after the old local deadline`, { timeout: 45_000 }, async t => {
    const f = await machineBrowserFixture(t, { machineEngine }), { machine, human } = f;
    const caps = ["screen.publish"];
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
      [f.roomId, await f.grant(caps, 2, { expiresAt: Math.floor(Date.now() / 1000) + 60 })]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    const outcome = await machine.evaluate(async grant => {
      const originalFetch = window.fetch, originalNow = Date.now;
      const previous = window.anantaMachine.status().lease;
      const result = { serverAccepted: false, nextGeneration: false, denied: false, joined: true };
      window.fetch = async function (input, init) {
        const response = await originalFetch.call(this, input, init);
        if (input === "/api/machine/sessions/renew") {
          const next = await response.clone().json();
          result.serverAccepted = response.status === 200;
          result.nextGeneration = next.generation === previous.generation + 1;
          // Only this private browser's decision clock changes, after actual
          // Ed25519/P-256 authorization. No server clock or timer is bypassed.
          // The old expiry timer is still pending in real time.
          Date.now = () => previous.expiresAt;
        }
        return response;
      };
      try {
        await window.anantaMachine.renew(grant);
      } catch (error) {
        result.denied = error?.message === "machine_renewal_scope_changed";
      } finally { window.fetch = originalFetch; Date.now = originalNow; }
      result.joined = window.anantaMachine.status().joined;
      return result;
    }, await f.grant(caps));
    assert.deepEqual(outcome, { serverAccepted: true, nextGeneration: true, denied: true, joined: false });
    await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor({ timeout: 2000 });
    assert.deepEqual(await machine.evaluate(() => ({ lease: window.anantaMachine.status().lease,
      openConnections: window.__pcs.filter(pc => pc.connectionState !== "closed").length,
      captures: window.__captures, errors: window.__transformErrors,
    })), { lease: null, openConnections: 0, captures: 0, errors: [] });
    t.diagnostic("Private browser decision-clock fault after real server acceptance; no public Hub or long-run evidence.");
  });
}

test("a stuck real-browser renewal proof settles and retires its authenticated membership", { timeout: 60_000 }, async t => {
  const f = await machineBrowserFixture(t), { machine, human } = f;
  const caps = ["screen.publish"];
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  // Test-owned fault at the non-abortable WebCrypto boundary, AFTER an actual
  // authenticated join. Never bypass device proof or submit a fake signature.
  await machine.evaluate(grant => {
    const original = crypto.subtle.sign;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    window.__renewalDeadline = { intercepted: 0, settled: false, timedOut: false };
    window.__restoreRenewalProof = () => { crypto.subtle.sign = original; release(new ArrayBuffer(0)); };
    crypto.subtle.sign = function (algorithm, ...args) {
      if (algorithm?.name === "ECDSA") {
        ++window.__renewalDeadline.intercepted;
        return held;
      }
      return original.call(this, algorithm, ...args);
    };
    void window.anantaMachine.renew(grant).then(
      () => { window.__renewalDeadline.settled = true; },
      error => { window.__renewalDeadline.settled = true;
        window.__renewalDeadline.timedOut = error?.message === "machine_renewal_timeout"; },
    );
  }, await f.grant(caps));
  try {
    await waitFixtureValue(machine, () => window.__renewalDeadline.settled, undefined, { timeout: 15_000 });
    assert.deepEqual(await machine.evaluate(() => window.__renewalDeadline),
      { intercepted: 1, settled: true, timedOut: true });
    await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor({ timeout: 2000 });
    assert.deepEqual(await machine.evaluate(() => ({
      joined: window.anantaMachine.status().joined,
      openConnections: window.__pcs.filter(pc => pc.connectionState !== "closed").length,
      captures: window.__captures, errors: window.__transformErrors,
    })), { joined: false, openConnections: 0, captures: 0, errors: [] });
  } finally {
    await machine.evaluate(() => {
      window.__restoreRenewalProof(); delete window.__restoreRenewalProof;
    });
  }
  // Completion of the old proof cannot trigger admission or restore membership.
  assert.equal(await machine.evaluate(() => window.anantaMachine.status().joined), false);
  t.diagnostic("Synthetic WebCrypto hang; real TLS/Ed25519/P-256 initial admission and membership retirement. No public Hub evidence.");
});
