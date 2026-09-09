import { expect, it } from "vitest";
import { selectedReceiveSources } from "./machine-receive-selection";
import { machineReceiveCapability } from "./machine-receive-capability";

it("keeps audio-only callers unchanged and independently compiles all four source kinds", () => {
  expect(selectedReceiveSources(true, true)).toEqual(["microphone", "screen-audio"]);
  expect(selectedReceiveSources(false, false, { camera: true, screen: true })).toEqual(["camera", "screen"]);
  expect(selectedReceiveSources(true, true, { camera: true, screen: true })).toEqual(["microphone", "screen-audio", "camera", "screen"]);
  expect(["microphone", "screen-audio", "camera", "screen", "__proto__"].map(machineReceiveCapability))
    .toEqual(["audio.receive", "audio.receive", "video.receive", "video.receive", null]);
});
it.each([null, [], {}, { camera: true }, { camera: 1, screen: false }, { camera: false, screen: false, extra: true }])(
  "rejects non-closed visual selections %j", input => { expect(() => selectedReceiveSources(false, false, input as never)).toThrow(); });
