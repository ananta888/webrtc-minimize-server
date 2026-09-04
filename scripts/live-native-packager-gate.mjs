import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { admitNativePackager, nativePackagerFfmpegArguments } from "../src/native-packager-policy.js";

if (process.env.RUN_LIVE_NATIVE_PACKAGER !== "1") {
  console.log("SKIP live native packager gate: set RUN_LIVE_NATIVE_PACKAGER=1 with FFmpeg 6+");
  process.exit(0);
}

const version = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error("ffmpeg_6_or_newer_required");
const now = Date.now();
const capability = {
  capabilityVersion: 1, agentId: "live-packager", tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa",
  agentVersion: "1.0.0", ffmpegVersion: version.stdout.match(/^ffmpeg version ([^\s]+)/)?.[1] || "unknown",
  videoEncoders: ["libx264"], audioEncoders: ["aac"], hardwareClass: "large", cpuClass: "high",
  gpuClass: "none", uploadClass: "over-15mbit", energyClass: "ac", health: "healthy",
  maximumRenditions: 3, maximumPixelsPerSecond: 1280 * 720 * 30,
  consentedRoomIds: ["room-live"], observedAt: now, expiresAt: now + 30_000,
};
const admission = admitNativePackager(capability, {
  requestVersion: 1, trigger: "user-action", tenantId: capability.tenantId,
  ownerSubjectRef: capability.ownerSubjectRef, roomId: "room-live",
  programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 1, resourceRef: "res_aaaaaaaaaaaaaaaa",
  requestedRenditions: 3, allowHardwareAcceleration: false,
}, now);
const root = await mkdtemp(path.join(os.tmpdir(), "webrtc-native-packager-"));
const pipeline = nativePackagerFfmpegArguments(admission, root);
try {
  for (const { id } of admission.renditions) await mkdir(path.join(pipeline.outputDirectory, id), { recursive: true });
  const consumer = spawn(pipeline.command, pipeline.args, { stdio: ["pipe", "ignore", "pipe"] });
  const producer = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "6",
    "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "mpegts", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  producer.stdout.pipe(consumer.stdin);
  let errors = "";
  consumer.stderr.on("data", (chunk) => { errors = `${errors}${chunk}`.slice(-8_000); });
  const [producerCode, consumerCode] = await Promise.all([
    new Promise((resolve) => producer.on("close", resolve)),
    new Promise((resolve) => consumer.on("close", resolve)),
  ]);
  assert.equal(producerCode, 0);
  assert.equal(consumerCode, 0, errors);
  const master = await readFile(path.join(pipeline.outputDirectory, "master.m3u8"), "utf8");
  assert.match(master, /low\/index\.m3u8/);
  assert.match(master, /medium\/index\.m3u8/);
  assert.match(master, /high\/index\.m3u8/);
  for (const { id } of admission.renditions) {
    const playlist = await readFile(path.join(pipeline.outputDirectory, id, "index.m3u8"), "utf8");
    assert.match(playlist, /#EXT-X-INDEPENDENT-SEGMENTS/);
    assert.match(playlist, /#EXT-X-ENDLIST/);
  }
  console.log("PASS native FFmpeg packager: three H.264/AAC renditions, aligned keyframe policy and bounded HLS window");
} finally {
  await rm(root, { recursive: true, force: true });
}
