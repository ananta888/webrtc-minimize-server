import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { normalizeNativeSourceVideoOutput } from "../src/native-source-video-output.js";
import { admitNativePackager, nativePackagerFfmpegArguments } from "../src/native-packager-policy.js";

const now = 1800000000000;
const capability = { ...JSON.parse(fs.readFileSync(new URL("./fixtures/native-source-capability.v2.json", import.meta.url))).capability,
  cpuClass: "high", uploadClass: "over-15mbit", maximumRenditions: 3, maximumPixelsPerSecond: 50000000 };
const request = { requestVersion: 3, trigger: "user-action", tenantId: capability.tenantId,
  ownerSubjectRef: capability.ownerSubjectRef, roomId: capability.consentedRoomIds[0], programId: "prg_aaaaaaaaaaaaaaaa",
  programEpoch: 1, resourceRef: "res_aaaaaaaaaaaaaaaa", requestedRenditions: 3, allowHardwareAcceleration: false,
  audioOutput: null, videoOutput: { profile: "screen-v1" } };
const expected = {
  "balanced-v1": [[640, 360, 15, 500000], [960, 540, 24, 1100000], [1280, 720, 30, 2400000]],
  "economy-v1": [[426, 240, 10, 250000], [640, 360, 15, 500000], [960, 540, 15, 900000]],
  "screen-v1": [[640, 360, 10, 400000], [960, 540, 10, 800000], [1280, 720, 10, 1400000]],
};

test("v3 start schema requires exact video and nullable audio without changing v1/v2", () => {
  const load = version => new Ajv({ strict: true }).compile(JSON.parse(fs.readFileSync(
    new URL(`../contracts/native-packager/source-program-start.v${version}.schema.json`, import.meta.url))));
  const validate = load(3);
  const start = { requestVersion: 3, trigger: "user-action", inputMode: "trusted-sframe-v1", packagerId: capability.agentId,
    requestedRenditions: 2, allowHardwareAcceleration: false, deviceFingerprint: "a".repeat(43),
    videoOutput: { profile: "economy-v1" }, audioOutput: null };
  assert.equal(validate(start), true, JSON.stringify(validate.errors));
  assert.equal(load(1)(start), false); assert.equal(load(2)(start), false);
  for (const key of Object.keys(start)) {
    const missing = { ...start }; delete missing[key]; assert.equal(validate(missing), false, key);
  }
  for (const patch of [{ videoOutput: { profile: "screen-v2" } }, { videoOutput: { profile: "screen-v1", fps: 60 } },
    { extra: true }, { audioOutput: {} }, { requestVersion: 2 }]) assert.equal(validate({ ...start, ...patch }), false);
});

test("video choice is a closed immutable strategy, never arbitrary encoder input", () => {
  for (const value of [null, [], {}, { profile: "__proto__" }, { profile: "screen-v2" },
    { profile: "screen-v1", fps: 60 }, { Profile: "screen-v1" }, { profile: 1 }]) {
    assert.throws(() => normalizeNativeSourceVideoOutput(value));
  }
  const selected = { profile: "screen-v1" }, normalized = normalizeNativeSourceVideoOutput(selected);
  selected.profile = "economy-v1";
  assert.equal(normalized.profile, "screen-v1"); assert.ok(Object.isFrozen(normalized));
});

for (const [profile, values] of Object.entries(expected)) test(`${profile} projects exact values and spends aggregate pixels once`, () => {
  const selected = { ...request, videoOutput: { profile } };
  const result = admitNativePackager(capability, selected, now);
  assert.equal(result.admissionVersion, 3);
  assert.deepEqual(result.renditions.map(r => [r.width, r.height, r.framesPerSecond, r.videoBitsPerSecond]), values);
  assert.ok(Object.isFrozen(result.videoOutput)); assert.ok(result.renditions.every(Object.isFrozen));
  assert.equal("audioOutput" in result, false);
  let pixels = 0;
  for (let count = 1; count <= 3; count++) {
    pixels += values[count - 1][0] * values[count - 1][1] * values[count - 1][2];
    for (const below of [0, 1]) {
      if (pixels - below < 640 * 360 * 10) continue; // Capability contract's existing minimum.
      const limited = { ...capability, maximumPixelsPerSecond: pixels - below };
      if (count === 1 && below) assert.throws(() => admitNativePackager(limited, selected, now), /capacity_rejected/);
      else assert.equal(admitNativePackager(limited, selected, now).renditions.length, count - below);
    }
  }
  const pipeline = nativePackagerFfmpegArguments(result, "/tmp/synthetic-output");
  for (const [index, value] of values.entries()) {
    assert.equal(pipeline.args[pipeline.args.indexOf(`-r:v:${index}`) + 1], String(value[2]));
    assert.equal(pipeline.args[pipeline.args.indexOf(`-g:v:${index}`) + 1], String(value[2] * 2));
    assert.equal(pipeline.args[pipeline.args.indexOf(`-b:v:${index}`) + 1], String(value[3]));
  }
});

test("video selection cannot bypass source opt-in, exact v3 fields, consent or audio capability", () => {
  for (const mutation of [{ sourcePrograms: false }, { consentedRoomIds: [] }, { energyClass: "battery" }]) {
    assert.throws(() => admitNativePackager({ ...capability, ...mutation }, request, now));
  }
  for (const mutation of [{ audioOutput: undefined }, { videoOutput: null }, { requestVersion: 1 },
    { requestVersion: 2 }, { extra: true }]) assert.throws(() => admitNativePackager(capability, { ...request, ...mutation }, now));
  const audioOutput = { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 };
  assert.throws(() => admitNativePackager(capability, { ...request, audioOutput }, now), /audio_output_unsupported/);
  const capable = { ...capability, capabilityVersion: 5, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1 };
  const combined = admitNativePackager(capable, { ...request, audioOutput }, now);
  assert.deepEqual(combined.audioOutput, audioOutput);
  assert.ok(combined.renditions.every(r => r.audioChannels === 1 && r.audioBitsPerSecond === 48000));
});
