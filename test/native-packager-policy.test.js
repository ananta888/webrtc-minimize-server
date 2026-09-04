import assert from "node:assert/strict";
import test from "node:test";

import {
  NativePackagerPolicyError,
  admitNativePackager,
  nativePackagerFfmpegArguments,
  normalizeNativePackagerCapability,
} from "../src/native-packager-policy.js";

const now = 1_800_000_000_000;
const capability = {
  capabilityVersion: 1, agentId: "mini-packager", tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa",
  agentVersion: "1.0.0", ffmpegVersion: "6.1.1",
  videoEncoders: ["libx264", "h264_vaapi"], audioEncoders: ["aac"],
  hardwareClass: "large", cpuClass: "high", gpuClass: "integrated",
  uploadClass: "over-15mbit", energyClass: "ac", health: "healthy",
  maximumRenditions: 3, maximumPixelsPerSecond: 1280 * 720 * 30,
  consentedRoomIds: ["room-alpha"], observedAt: now, expiresAt: now + 30_000,
};
const request = {
  requestVersion: 1, trigger: "user-action", tenantId: capability.tenantId,
  ownerSubjectRef: capability.ownerSubjectRef, roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 1,
  resourceRef: "res_aaaaaaaaaaaaaaaa", requestedRenditions: 3,
  allowHardwareAcceleration: true,
};

test("native packager admission is exact-owner, tenant, room-consent and health bound", () => {
  const admitted = admitNativePackager(capability, request, now);
  assert.equal(admitted.videoEncoder, "h264_vaapi");
  assert.equal(admitted.softwareFallback, "libx264");
  assert.deepEqual(admitted.renditions.map(({ id }) => id), ["low", "medium", "high"]);
  for (const mutation of [
    { tenantId: "tn_bbbbbbbbbbbbbbbb" }, { ownerSubjectRef: "sub_bbbbbbbbbbbbbbbb" },
    { roomId: "room-other" }, { trigger: "remote-signal" },
  ]) assert.throws(() => admitNativePackager(capability, { ...request, ...mutation }, now), NativePackagerPolicyError);
  assert.throws(() => admitNativePackager({ ...capability, energyClass: "battery" }, request, now), /unavailable/);
  assert.throws(() => admitNativePackager({ ...capability, health: "draining" }, request, now), /unavailable/);
});

test("capacity classes reduce ABR without believing a self-reported authority", () => {
  const admitted = admitNativePackager({
    ...capability, cpuClass: "low", uploadClass: "under-5mbit", maximumRenditions: 3,
  }, request, now);
  assert.deepEqual(admitted.renditions.map(({ id }) => id), ["low"]);
  assert.equal(admitted.maximumQueueFrames, 60);
  assert.throws(() => normalizeNativePackagerCapability({ ...capability, authority: "owner" }, now), /invalid/);
  assert.throws(() => normalizeNativePackagerCapability({ ...capability, expiresAt: now - 1 }, now), /invalid/);
});

test("FFmpeg pipeline uses argv without shell, aligned keyframes and a confined opaque output path", () => {
  const admitted = admitNativePackager(capability, request, now);
  const pipeline = nativePackagerFfmpegArguments(admitted, "/var/lib/webrtc-packager");
  assert.equal(pipeline.command, "ffmpeg");
  assert.equal(pipeline.outputDirectory, "/var/lib/webrtc-packager/res_aaaaaaaaaaaaaaaa");
  assert.ok(pipeline.args.includes("pipe:0"));
  assert.ok(pipeline.args.includes("independent_segments+delete_segments+program_date_time"));
  assert.equal(pipeline.args.filter((value) => value === "0").length >= 3, true);
  assert.ok(pipeline.args.every((value) => !/[\u0000\r\n]/.test(value)));
  assert.throws(() => nativePackagerFfmpegArguments({ ...admitted, resourceRef: "../escape" }, "/safe"), /invalid/);
});
