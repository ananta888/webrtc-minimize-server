import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { sceneViewerObservation } from "./helpers/native-scene-viewer.mjs";

function page(codes) {
  return { evaluate: callback => vm.runInNewContext(`(${callback.toString()})()`, {
    document: { querySelector: selector => selector in codes ? { textContent: codes[selector] } : null },
  }) };
}

test("synthetic viewer diagnostics distinguish player and authorization failures", async () => {
  const result = await sceneViewerObservation(page({
    "#broadcast-open-error": "broadcast_not_available",
    "app-broadcast-player .player-message[role=alert] span": "broadcast_player_recovery_exhausted",
  }));
  assert.equal(result.exists, false);
  assert.equal(result.errorCode, "broadcast_not_available");
  assert.equal(result.playerErrorCode, "broadcast_player_recovery_exhausted");
});

test("synthetic viewer diagnostics do not forward arbitrary DOM text", async () => {
  for (const value of ["https://private.invalid/token", "TOKEN_CANARY", "broadcast_" + "x".repeat(81), ""]) {
    const result = await sceneViewerObservation(page({
      "#broadcast-open-error": value,
      "app-broadcast-player .player-message[role=alert] span": value,
    }));
    assert.equal(result.errorCode, null);
    assert.equal(result.playerErrorCode, null);
  }
});
