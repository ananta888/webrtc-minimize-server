import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { decodedGreenScreen } from "./helpers/machine-avatar-coexistence.mjs";
import { beforeMachineLeaseExpiry, isMachineLeaseObservation, machineLeaseSupplyObservation } from "./helpers/machine-lifecycle-observation.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

// Keep supplying only synthetic frames. Missing renewal, not an artificial frame
// stall or an explicit Leave, must revoke the session and release its resources.
function supplyUntilLeaseEnds(sessionId) {
  const api = window.anantaMachine, lease = api.screen.open("screen:" + sessionId);
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "rgb(20,220,20)"; ctx.fillRect(0, 0, 640, 360);
  const jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
  const state = { generation: lease.generation, sequence: 0, lastAccepted: 0, closedAt: 0,
    error: false, timer: null, stopped: false, tracks: [], pushInFlight: false, lastPushDurationMs: 0,
    close() { this.stopped = true; clearTimeout(this.timer); } };
  window.__leaseSource = state;
  const tick = async () => {
    if (state.stopped || state.sequence >= 80) return;
    const started = performance.now(); state.pushInFlight = true;
    try {
      await api.screen.push(lease.generation, ++state.sequence, jpeg);
      state.lastAccepted = Date.now();
      for (const pc of window.__pcs) for (const sender of pc.getSenders()) {
        if (sender.track && !state.tracks.includes(sender.track)) state.tracks.push(sender.track);
      }
      if (!state.stopped) state.timer = setTimeout(tick, 250);
    } catch {
      state.closedAt = Date.now(); state.error = true;
    } finally {
      state.pushInFlight = false; state.lastPushDurationMs = performance.now() - started;
    }
  };
  void tick();
}

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} observes real lease expiry stop an actively supplied machine screen`, { timeout: 45000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine }), { machine, human } = f;
    t.after(async () => { if (!machine.isClosed()) await machine.evaluate(() => window.__leaseSource?.close()); });
    const started = performance.now();
    const socketStops = [];
    f.app.webSocketServer.on("connection", socket => socket.once("close", (code, reason) => {
      if (socketStops.length < 2) socketStops.push({ code,
        expiry: reason.toString() === "machine_session_expired", elapsedMs: Math.round(performance.now() - started) });
    }));
    const expiresAt = Math.floor(Date.now() / 1000) + 15;
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
      [f.roomId, await f.grant(["screen.publish"], 2, { expiresAt })]);
    const lease = await machine.evaluate(() => window.anantaMachine.status().lease);
    assert.equal(lease.expiresAt, expiresAt * 1000);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    await machine.evaluate(supplyUntilLeaseEnds, f.binding.sessionId);
    await human.waitForFunction(decodedGreenScreen, null, { timeout: 7000 });
    const observed = await waitFixtureValue(machine, beforeMachineLeaseExpiry, lease.expiresAt,
      { timeout: 16000, accept: isMachineLeaseObservation });
    const { observedAt, ...beforeExpiry } = observed;
    const inWindow = observedAt >= lease.expiresAt - 700 && observedAt < lease.expiresAt;
    if (!beforeExpiry.joined || !beforeExpiry.open || !inWindow) t.diagnostic(JSON.stringify({
      phase: "before-expiry", elapsedMs: Math.round(performance.now() - started),
      nodeRemainingMs: lease.expiresAt - Date.now(), browserRemainingMs: await machine.evaluate(deadline => deadline - Date.now(), lease.expiresAt),
      socketStops, beforeExpiry, observedAt }));
    assert.ok(inWindow,
      "pre-expiry observation must occur inside the original window, not after expiry");
    assert.deepEqual(beforeExpiry,
    { joined: true, open: true, error: false, e2ee: "active" });
    await machine.waitForFunction(() => !window.anantaMachine.status().joined
      && !window.anantaMachine.screen.status().open && window.__leaseSource.closedAt > 0, null,
    { timeout: 2700, polling: 25 });
    const stopped = await machine.evaluate(() => ({ lastAccepted: window.__leaseSource.lastAccepted,
      closedAt: window.__leaseSource.closedAt, tracks: window.__leaseSource.tracks.length,
      ended: window.__leaseSource.tracks.every(track => track.readyState === "ended"),
      connectionsClosed: window.__pcs.every(pc => pc.connectionState === "closed") }));
    if (stopped.lastAccepted < lease.expiresAt - 1000 || stopped.closedAt > lease.expiresAt + 2000) {
      t.diagnostic(JSON.stringify({ phase: "lease-supply-stop", synthetic: true, productionEvidence: false,
        ...await machine.evaluate(machineLeaseSupplyObservation, lease.expiresAt) }));
    }
    assert.ok(stopped.lastAccepted >= lease.expiresAt - 1000, "source was live immediately before expiry");
    assert.ok(stopped.closedAt <= lease.expiresAt + 2000, "no fresh grant: bounded stop");
    assert.ok(stopped.tracks > 0); assert.equal(stopped.ended, true); assert.equal(stopped.connectionsClosed, true);
    await human.locator("#participant-count", { hasText: "1 / 20" }).waitFor({ timeout: 2000 });
    await human.waitForFunction(() => document.querySelectorAll("video").length === 0, null, { timeout: 2000 });
    assert.ok(Date.now() <= lease.expiresAt + 2000, "sender, membership and remote display share the stop budget");
    const denied = await machine.evaluate(async fresh => {
      const api = window.anantaMachine; let push = false, renew = false;
      try { await api.screen.push(window.__leaseSource.generation, window.__leaseSource.sequence + 1, ""); } catch { push = true; }
      try { await api.renew(fresh); } catch { renew = true; }
      return { push, renew, joined: api.status().joined };
    }, await f.grant(["screen.publish"]));
    assert.deepEqual(denied, { push: true, renew: true, joined: false });
    for (const page of [machine, human]) assert.deepEqual(await page.evaluate(() => ({ captures: window.__captures,
      errors: window.__transformErrors })), { captures: 0, errors: [] });
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false,
      expiredWhileSupplied: true, stopAfterDeadlineMs: stopped.closedAt - lease.expiresAt,
      endedTracks: stopped.tracks, latePushAndRenewDenied: true }));
  });
}
