import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { classifyScenePixels, probeSceneFragment } from "./helpers/native-scene-fragment-probe.mjs";

test("scene fragment classification is fixed and cannot emit pixels, text or partial output", () => {
  assert.deepEqual(classifyScenePixels(Buffer.from([224, 32, 32, 32, 32, 224])), ["red", "blue"]);
  assert.deepEqual(classifyScenePixels(Buffer.from([8, 19, 31, 120, 180, 222])), ["slate", "other"]);
  for (const input of [null, "private content", new Uint8Array(6), Buffer.alloc(5), Buffer.alloc(7)]) assert.equal(classifyScenePixels(input), null);
});
test("scene probe bounds input and returns null for invalid media without exposing decoder errors", async () => {
  for (const input of [null, Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 65537), Buffer.from("private invalid media")]) {
    assert.equal(await probeSceneFragment(input), null);
  }
});
test("scene probe classifies two actual encoded synthetic H264 tiles", { timeout: 15000 }, async t => {
  const execute = promisify(execFile);
  try { await execute("ffmpeg", ["-version"], { timeout: 2000, maxBuffer: 32768 }); }
  catch { t.skip("Local FFmpeg required for encoded synthetic scene probe"); return; }
  const { stdout } = await execute("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=red:s=64x36:r=10",
    "-f", "lavfi", "-i", "color=blue:s=64x36:r=10", "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]",
    "-frames:v", "2", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"], { timeout: 5000, maxBuffer: 65536, encoding: "buffer" });
  assert.deepEqual(await probeSceneFragment(stdout), ["red", "blue"]);
});
