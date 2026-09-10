import assert from "node:assert/strict";
import test from "node:test";
import { videoOutputProbeResult, probeNativeVideoOutput } from "./helpers/native-video-output-probe.mjs";
const valid = { codec_name: "h264", width: 426, height: 240, r_frame_rate: "10/1", nb_read_frames: "20" };
const result = value => videoOutputProbeResult(JSON.stringify({ streams: [value] }));
test("video probe projects decoded bounded H264 values without retaining raw metadata", () => {
  assert.deepEqual(result({ ...valid, tags: { private: "must-not-escape" } }),
    { codec: "h264", width: 426, height: 240, framesPerSecond: 10, decodedFrames: 20 });
  for (const patch of [{ codec_name: "vp8" }, { width: 10000 }, { height: 0 }, { r_frame_rate: "0/0" },
    { r_frame_rate: "61/1" }, { nb_read_frames: "N/A" }, { nb_read_frames: "0" }, { nb_read_frames: "181" }]) assert.equal(result({ ...valid, ...patch }), null);
  for (const text of ["invalid", "x".repeat(4097), "{}", JSON.stringify({ streams: [valid, valid] })]) assert.equal(videoOutputProbeResult(text), null);
});
test("video probe rejects non-fragments before spawning", async () => {
  for (const value of [null, "untrusted", Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 65537)]) {
    assert.equal(await probeNativeVideoOutput(value), null);
  }
});
