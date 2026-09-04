import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.env.RUN_LIVE_BROADCAST_QUALITY !== "1") {
  console.log("SKIP broadcast quality gate: set RUN_LIVE_BROADCAST_QUALITY=1 with FFmpeg 6+");
  process.exit(0);
}

const durationSeconds = Number(process.env.BROADCAST_QUALITY_DURATION_SECONDS || 5);
assert.ok(Number.isSafeInteger(durationSeconds) && durationSeconds >= 3 && durationSeconds <= 60);
const directory = mkdtempSync(join(tmpdir(), "webrtc-broadcast-quality-"));
const encoded = join(directory, "encoded.mp4");

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.slice(-2_000));
  return `${result.stdout}\n${result.stderr}`;
}

try {
  const encodeStarted = performance.now();
  ffmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-t", String(durationSeconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-an", encoded,
  ]);
  const encodeDurationMs = performance.now() - encodeStarted;
  const output = ffmpeg([
    "-hide_banner", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${durationSeconds}`,
    "-i", encoded, "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-",
  ]);
  const match = output.match(/SSIM Y:([\d.]+).*U:([\d.]+).*V:([\d.]+).*All:([\d.]+)/);
  assert.ok(match, "missing_ssim_result");
  const bytes = statSync(encoded).size;
  const result = {
    gate: "broadcast-quality-ssim-v1",
    fixture: "testsrc2-1280x720-30fps-libx264-crf23",
    durationSeconds,
    encodedBytes: bytes,
    encodedMegabitsPerSecond: Number((bytes * 8 / durationSeconds / 1_000_000).toFixed(4)),
    encodeDurationMs: Number(encodeDurationMs.toFixed(2)),
    realtimeFactor: Number((durationSeconds * 1_000 / encodeDurationMs).toFixed(3)),
    ssim: { y: Number(match[1]), u: Number(match[2]), v: Number(match[3]), all: Number(match[4]) },
  };
  assert.ok(result.ssim.all >= 0.95);
  assert.ok(result.realtimeFactor >= 1);
  console.log(JSON.stringify(result));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
