import assert from "node:assert/strict";
import test from "node:test";
import { verifyProductionHandoff } from "../scripts/live-production-handoff-gate.mjs";

function fixture({ controlStatus = 200, handoffStatus = 201, missingRequest = false, failedTransport = false, missingManifest = false } = {}) {
  let responses = 0;
  const pending = () => new Promise(() => {});
  const response = status => ({ status: () => status, json: async () => ({ error: "native_packager_unavailable" }) });
  const owner = {
    evaluate: async () => ({ capture: [], connections: 1 }),
    waitForResponse: () => ++responses === 1 ? Promise.resolve(response(controlStatus))
      : failedTransport ? pending() : Promise.resolve(response(handoffStatus)),
    waitForRequest: () => missingRequest ? Promise.reject(new Error("fixture timeout")) : Promise.resolve({}),
    waitForEvent: () => failedTransport ? Promise.resolve({ failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) }) : pending(),
    once: () => {},
    locator: () => ({ selectOption: async () => {}, click: async () => {}, allTextContents: async () => ["broadcast_state_conflict"] }),
  };
  const viewer = {
    url: () => "https://webrtc.example/?program=prg_aaaaaaaaaaaaaaaa",
    locator: () => ({ evaluate: async () => "blob:old", selectOption: async () => {} }),
    evaluate: async () => ({ player: "failed", errors: ["broadcast_not_available"] }),
    waitForRequest: () => missingManifest ? Promise.reject(new Error("fixture manifest timeout")) : pending(),
  };
  return { owner, viewer, targetId: "pkr_bbbbbbbbbbbbbbbb", programCreates: () => 0, statuses: [], report: () => {},
    manifest: "https://webrtc.example/broadcast/play/res_aaaaaaaaaaaaaaaa/master.m3u8" };
}

test("handoff gate reports a rejected control response without waiting for unavailable media", async () => {
  await assert.rejects(verifyProductionHandoff(fixture({ controlStatus: 403 })), /handoff control rejected: native_packager_unavailable/);
});

test("handoff gate reports a rejected mutation before waiting for a successor manifest", async () => {
  await assert.rejects(verifyProductionHandoff(fixture({ handoffStatus: 409 })), /handoff rejected: native_packager_unavailable/);
});

test("handoff gate distinguishes a locally missing request from a missing response", async () => {
  await assert.rejects(verifyProductionHandoff(fixture({ missingRequest: true })),
    /native_handoff_response_missing:request=false:ui=true:broadcast_state_conflict:no_transport_error/);
});

test("handoff gate preserves a classified browser transport failure after a sent request", async () => {
  await assert.rejects(verifyProductionHandoff(fixture({ failedTransport: true })),
    /native_handoff_response_missing:request=true:ui=true:broadcast_state_conflict:native_handoff_transport_failed:net::ERR_NETWORK_CHANGED/);
});

test("accepted handoff without a manifest reports bounded status without program or packager IDs", async () => {
  const input = fixture({ missingManifest: true });
  input.statuses.push({ programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 3, packagerId: input.targetId,
    state: "failed", reasonCode: "TRANSCODE_FAILED" });
  await assert.rejects(verifyProductionHandoff(input), error => {
    assert.match(error.message, /native_handoff_manifest_missing:/);
    assert.match(error.message, /TRANSCODE_FAILED/);
    assert.match(error.message, /broadcast_not_available/);
    assert.ok(!error.message.includes("prg_") && !error.message.includes("pkr_"));
    return true;
  });
});
