import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBroadcastDelivery } from "../src/broadcast-delivery-policy.js";

const base = {
  mode: "browser-single-whip", videoCodec: "vp8", audioCodec: "opus",
  encodingCount: 1, simulcastNegotiated: false, gatewayTranscodes: false,
};

test("single browser WHIP never invents an adaptive HLS ladder", () => {
  const result = evaluateBroadcastDelivery(base);
  assert.equal(result.broadHlsCompatible, false);
  assert.equal(result.adaptiveBitrate, false);
  assert.equal(result.independentlySelectableRenditions, 1);
  assert.equal(result.reason, "trusted_transcode_required");
});

test("browser simulcast remains distinct from independently selectable HLS renditions", () => {
  const result = evaluateBroadcastDelivery({
    ...base, mode: "browser-simulcast-whip", encodingCount: 3, simulcastNegotiated: true,
  });
  assert.equal(result.adaptiveBitrate, false);
  assert.equal(result.independentlySelectableRenditions, 1);
  assert.throws(() => evaluateBroadcastDelivery({
    ...base, mode: "browser-simulcast-whip", encodingCount: 3,
  }), /not_negotiated/);
});

test("only native compatible renditions advertise ABR", () => {
  const result = evaluateBroadcastDelivery({
    ...base, mode: "native-abr", videoCodec: "h264", audioCodec: "aac", encodingCount: 3,
  });
  assert.equal(result.broadHlsCompatible, true);
  assert.equal(result.adaptiveBitrate, true);
  assert.equal(result.independentlySelectableRenditions, 3);
  assert.throws(() => evaluateBroadcastDelivery({ ...base, gatewayTranscodes: true }), /transcoding_not_supported/);
  assert.throws(() => evaluateBroadcastDelivery({ ...base, unknown: true }), /invalid/);
});
