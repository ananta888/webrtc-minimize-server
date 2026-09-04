import { describe, expect, it } from "vitest";

import { BroadcastViewerQualityPolicy } from "./broadcast-viewer-quality-policy";

const renditions = Object.freeze([
  { index: 0, bitrate: 500_000, height: 360 },
  { index: 1, bitrate: 1_100_000, height: 540 },
  { index: 2, bitrate: 2_400_000, height: 720 },
]);
const sample = (sampledAt: number, overrides = {}) => ({
  sampledAt,
  bandwidthEstimateBitsPerSecond: 8_000_000,
  bufferSeconds: 8,
  decodedFrames: 300,
  droppedFrames: 0,
  lowPowerMode: false,
  ...overrides,
});

describe("BroadcastViewerQualityPolicy", () => {
  it("upgrades only after three healthy samples and a ten-second hold", () => {
    const policy = new BroadcastViewerQualityPolicy("auto");
    expect(policy.evaluate(renditions, sample(1_000)).targetIndex).toBe(0);
    expect(policy.evaluate(renditions, sample(5_000)).changed).toBe(false);
    expect(policy.evaluate(renditions, sample(10_999)).changed).toBe(false);
    expect(policy.evaluate(renditions, sample(11_000))).toMatchObject({ targetIndex: 1, changed: true, reason: "stable" });
  });

  it("downgrades after two bad buffer samples instead of oscillating", () => {
    const policy = new BroadcastViewerQualityPolicy("high");
    policy.evaluate(renditions, sample(0));
    policy.setMode("auto");
    expect(policy.evaluate(renditions, sample(1_000, { bufferSeconds: 0.5 })).changed).toBe(false);
    expect(policy.evaluate(renditions, sample(2_000, { bufferSeconds: 0.5 })))
      .toMatchObject({ targetIndex: 1, changed: true, reason: "buffer" });
  });

  it("uses bandwidth and decode performance as independent downgrade signals", () => {
    const bandwidth = new BroadcastViewerQualityPolicy("high");
    bandwidth.evaluate(renditions, sample(0));
    bandwidth.setMode("auto");
    bandwidth.evaluate(renditions, sample(1_000, { bandwidthEstimateBitsPerSecond: 1_000_000 }));
    expect(bandwidth.evaluate(renditions, sample(2_000, { bandwidthEstimateBitsPerSecond: 1_000_000 })).reason).toBe("bandwidth");

    const decode = new BroadcastViewerQualityPolicy("high");
    decode.evaluate(renditions, sample(0));
    decode.setMode("auto");
    decode.evaluate(renditions, sample(1_000, { decodedFrames: 80, droppedFrames: 20 }));
    expect(decode.evaluate(renditions, sample(2_000, { decodedFrames: 80, droppedFrames: 20 })).reason).toBe("decode");
  });

  it("caps data saver and low at 360p and medium at 540p", () => {
    for (const [mode, expected] of [["data-saver", 0], ["low", 0], ["medium", 1]] as const) {
      const policy = new BroadcastViewerQualityPolicy(mode);
      expect(policy.evaluate(renditions, sample(0)).targetIndex).toBe(expected);
    }
  });

  it("keeps low-power automatic upgrades at or below 540p", () => {
    const policy = new BroadcastViewerQualityPolicy("auto");
    policy.evaluate(renditions, sample(0, { lowPowerMode: true }));
    policy.evaluate(renditions, sample(10_000, { lowPowerMode: true }));
    policy.evaluate(renditions, sample(11_000, { lowPowerMode: true }));
    expect(policy.evaluate(renditions, sample(12_000, { lowPowerMode: true })).targetIndex).toBe(1);
    policy.evaluate(renditions, sample(22_000, { lowPowerMode: true }));
    policy.evaluate(renditions, sample(23_000, { lowPowerMode: true }));
    expect(policy.evaluate(renditions, sample(24_000, { lowPowerMode: true })).targetIndex).toBe(1);
  });
});
