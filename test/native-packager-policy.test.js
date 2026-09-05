import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_BROADCAST_PROFILE,
  NativePackagerPolicyError,
  admitNativePackager,
  nativeFfmpegVersion,
  nativePackagerFfmpegArguments,
  nativePackagerPipelineCandidates,
  normalizeNativePackagerCapability,
  supportsNativeAssignmentV2,
} from "../src/native-packager-policy.js";

const now = 1_800_000_000_000;
const capability = {
  capabilityVersion: 1, agentId: "mini-packager", tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa",
  agentVersion: "1.0.0", ffmpegVersion: "6.1.1",
  videoEncoders: ["libx264", "h264_nvenc"], audioEncoders: ["aac"],
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
  assert.equal(admitted.videoEncoder, "h264_nvenc");
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
  assert.throws(
    () => normalizeNativePackagerCapability({ ...capability, ffmpegVersion: "5.1.6" }, now),
    /ffmpeg_6_or_newer_required/,
  );
});

test("FFmpeg capability parsing enforces the real minimum version", () => {
  assert.deepEqual(nativeFfmpegVersion("ffmpeg version 6.1.1 Copyright"), {
    raw: "ffmpeg version 6.1.1",
    major: 6,
    minor: 1,
    patch: 1,
  });
  assert.equal(nativeFfmpegVersion("7.2").major, 7);
  for (const value of ["", "unknown", "ffmpeg version 5.1.6", "6", "release-7.0"]) {
    assert.throws(() => nativeFfmpegVersion(value), /ffmpeg_6_or_newer_required/);
  }
});

test("hardware assignments require the additive v2-capable agent generation", () => {
  assert.equal(supportsNativeAssignmentV2("0.6.0"), true);
  assert.equal(supportsNativeAssignmentV2("1.0.0"), true);
  for (const version of ["0.5.9", "unknown", "0.6", "0.6.0 bad"]) {
    assert.equal(supportsNativeAssignmentV2(version), false);
  }
  const legacy = admitNativePackager({ ...capability, agentVersion: "0.5.9" }, request, now);
  assert.equal(legacy.videoEncoder, "libx264");
});

test("pilot profile fixes H.264 Main/AAC-LC ladder and aligned two-second GOPs", () => {
  assert.equal(NATIVE_BROADCAST_PROFILE.profileId, "h264-aac-720p-v1");
  assert.equal(NATIVE_BROADCAST_PROFILE.segmentDurationSeconds, 2);
  assert.equal(NATIVE_BROADCAST_PROFILE.partDurationMilliseconds, 200);
  assert.equal(NATIVE_BROADCAST_PROFILE.keyframeIntervalSeconds, 2);
  for (const rendition of NATIVE_BROADCAST_PROFILE.renditions) {
    assert.equal(rendition.videoCodec, "h264");
    assert.equal(rendition.videoProfile, "main");
    assert.equal(rendition.videoLevel, "3.1");
    assert.equal(rendition.audioCodec, "aac");
    assert.equal(rendition.audioProfile, "aac_low");
    assert.equal(rendition.audioSampleRate, 48_000);
    assert.equal(rendition.audioChannels, 2);
  }
});

test("FFmpeg pipeline uses argv without shell, aligned keyframes and a confined opaque output path", () => {
  const admitted = admitNativePackager(capability, request, now);
  const pipeline = nativePackagerFfmpegArguments(admitted, "/var/lib/webrtc-packager");
  assert.equal(pipeline.command, "ffmpeg");
  assert.equal(pipeline.outputDirectory, "/var/lib/webrtc-packager/res_aaaaaaaaaaaaaaaa");
  assert.ok(pipeline.args.includes("pipe:0"));
  assert.ok(pipeline.args.includes("independent_segments+delete_segments+program_date_time"));
  assert.ok(pipeline.args.includes("aac_low"));
  assert.ok(pipeline.args.includes("yuv420p"));
  assert.equal(pipeline.args[pipeline.args.indexOf("-hls_time") + 1], "2");
  assert.equal(pipeline.args.filter((value) => value === "0").length >= 3, true);
  assert.ok(pipeline.args.every((value) => !/[\u0000\r\n]/.test(value)));
  assert.throws(() => nativePackagerFfmpegArguments({ ...admitted, resourceRef: "../escape" }, "/safe"), /invalid/);
});

test("hardware admission always carries one deterministic software fallback pipeline", () => {
  const admitted = admitNativePackager(capability, request, now);
  const candidates = nativePackagerPipelineCandidates(admitted, "/var/lib/webrtc-packager");
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].args[candidates[0].args.indexOf("-c:v:0") + 1], "h264_nvenc");
  assert.equal(candidates[1].args[candidates[1].args.indexOf("-c:v:0") + 1], "libx264");
  assert.equal(candidates[0].outputDirectory, candidates[1].outputDirectory);

  const software = admitNativePackager({ ...capability, videoEncoders: ["libx264"] }, request, now);
  assert.equal(nativePackagerPipelineCandidates(software, "/var/lib/webrtc-packager").length, 1);
});
