import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { productionBroadcastScenario, inspectProductionBroadcastUi } from "../scripts/production-broadcast-scenario.mjs";

test("the default production scenario preserves private playback and visibility restart", () => {
  assert.deepEqual(productionBroadcastScenario(undefined, {}), { publicHandoffOnly: false, initialVisibility: "private" });
  assert.deepEqual(productionBroadcastScenario("full", {}), { publicHandoffOnly: false, initialVisibility: "private" });
});

test("direct public isolation requires two packagers and cannot claim excluded private scenarios", () => {
  const options = { hasHandoff: true, privateViewer: false, refreshRestore: false };
  assert.deepEqual(productionBroadcastScenario("public-handoff-only", options), { publicHandoffOnly: true, initialVisibility: "public" });
  for (const value of [{ ...options, hasHandoff: false }, { ...options, privateViewer: true }, { ...options, refreshRestore: true }]) {
    assert.throws(() => productionBroadcastScenario("public-handoff-only", value), /invalid_production_broadcast_scenario/);
  }
  assert.throws(() => productionBroadcastScenario("arbitrary", options), /invalid_production_broadcast_scenario/);
});

test("failure snapshot retains bounded states and codes, never arbitrary UI contents", () => {
  const secret = "SECRET-CANARY";
  const document = {
    querySelectorAll: () => Array.from({ length: 30 }, () => ({ textContent: `${secret} native_packager_stop_failed` })),
    querySelector: selector => selector === "#broadcast-program-status" ? { textContent: secret }
      : selector === "app-broadcast-player .state" ? { getAttribute: () => secret } : null,
  };
  const snapshot = runInNewContext(`(${inspectProductionBroadcastUi.toString()})()`, { document });
  assert.equal(snapshot.errors.length, 5);
  assert.equal(snapshot.errors[0], "native_packager_stop_failed");
  assert.equal(snapshot.publisher, "other");
  assert.equal(snapshot.player, "other");
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});
