import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { normalizeNativeSourceAudioOutput } from "../src/native-source-audio-output.js";
import { normalizeNativePackagerCapability, admitNativePackager, supportsNativeSourceAudioV1,
  supportsNativeSourceAudioV2, supportsNativeSourceAudioV3, nativePackagerFfmpegArguments } from "../src/native-packager-policy.js";
import { normalizeNativeSourceAudio, normalizeNativeSourceAudioQuery, normalizeNativeSourceAudioReply } from "../src/native-source-audio.js";
import { normalizeNativeAudioDirectorInput } from "../src/native-source-audio-director.js";
import { parseNativeSourceAudioReply } from "../src/native-source-audio-wire.js";

const read = path => JSON.parse(fs.readFileSync(new URL("../"+path, import.meta.url), "utf8"));
const now = 1800000000000;
const capability = read("test/fixtures/native-source-capability.v5.json").capability;
const output = { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 };
const request = { requestVersion: 2, trigger: "user-action", tenantId: capability.tenantId,
  ownerSubjectRef: capability.ownerSubjectRef, roomId: capability.consentedRoomIds[0], programId: "prg_aaaaaaaaaaaaaaaa",
  programEpoch: 1, resourceRef: "res_aaaaaaaaaaaaaaaa", requestedRenditions: 3, allowHardwareAcceleration: false, audioOutput: output };

test("all v3 native replies pass the strict raw wire parser before broker correlation", () => {
  for (const suffix of ["state", "applied", "rejected"]) {
    const value = read(`native-broadcast-packager/testdata/source-audio-${suffix}.v3.json`);
    assert.deepEqual(parseNativeSourceAudioReply(JSON.stringify(value)), value);
    assert.throws(() => parseNativeSourceAudioReply(JSON.stringify({ ...value, extra: true })));
    assert.throws(() => parseNativeSourceAudioReply(JSON.stringify({ ...value, version: 4 })));
    const raw = JSON.stringify(value);
    assert.throws(() => parseNativeSourceAudioReply(raw.replace('"version":3', '"version":3,"version":3')));
  }
});

test("v5 capability is explicit, closed and does not imply stereo-only audio v2", () => {
  const validate = new Ajv({strict:true}).compile(read("contracts/native-packager/capability.v5.schema.json"));
  assert.equal(validate(capability), true, JSON.stringify(validate.errors));
  const normalized = normalizeNativePackagerCapability(capability, now);
  assert.equal(supportsNativeSourceAudioV3(normalized), true);
  assert.equal(supportsNativeSourceAudioV1(normalized), true);
  assert.equal(supportsNativeSourceAudioV2(normalized), false);
  for (const patch of [{ sourceAudioEncodingVersion: undefined }, { sourceAudioEncodingVersion: 2 },
    { sourceAudioControlVersion: 2 }, { capabilityVersion: 4 }, { sourcePrograms: false }, { encoding: {} }]) {
    assert.throws(() => normalizeNativePackagerCapability({ ...capability, ...patch }, now));
  }
  assert.equal(new Ajv({strict:true}).compile(read("contracts/native-packager/capability.v4.schema.json"))(capability), false);
});

test("output normalization and admission retain caller-independent limits and actual ladder audio values", () => {
  const normalized = normalizeNativeSourceAudioOutput(output);
  assert.ok(Object.isFrozen(normalized)); assert.notEqual(normalized, output);
  for (const audioOutput of [null, { ...output, channels: 3 }, { ...output, targetBitsPerSecond: 192001 },
    { ...output, sampleRate: 44100 }, { ...output, targetBitsPerSecond: "48000" }, { ...output, extra: true }]) {
    assert.throws(() => admitNativePackager(capability, { ...request, audioOutput }, now), /invalid_native_packager_request/);
  }
  const admitted = admitNativePackager(capability, request, now);
  assert.equal(admitted.admissionVersion, 2); assert.deepEqual(admitted.audioOutput, output);
  assert.ok(Object.isFrozen(admitted.audioOutput));
  assert.ok(admitted.renditions.every(r => r.audioChannels === 1 && r.audioBitsPerSecond === 48000 && Object.isFrozen(r)));
  const pipeline = nativePackagerFfmpegArguments(admitted, "/tmp/owned-audio-output-test");
  assert.ok(pipeline.args.join(" ").includes("-ac:a:0 1"));
  assert.ok(pipeline.args.join(" ").includes("-b:a:0 48000"));
  const legacyCapability = read("test/fixtures/native-source-capability.v4.json").capability;
  assert.throws(() => admitNativePackager(legacyCapability, request, now), /native_source_audio_output_unsupported/);
  const legacy = { ...request, requestVersion: 1 }; delete legacy.audioOutput;
  const prior = admitNativePackager(legacyCapability, legacy, now);
  assert.equal(prior.admissionVersion, 1); assert.equal("audioOutput" in prior, false);
  assert.ok(prior.renditions.every(r => r.audioChannels === 2));
});

test("audio v3 normalizers share actual native mono observations and preserve v2 closure", () => {
  const fixture = suffix => read("native-broadcast-packager/testdata/source-audio"+suffix+".v3.json");
  const command = normalizeNativeSourceAudio(fixture(""), now), query = normalizeNativeSourceAudioQuery(fixture("-query"), now);
  for (const suffix of ["-state", "-applied", "-rejected"]) {
    const reply = normalizeNativeSourceAudioReply(fixture(suffix), suffix === "-state" ? query : command, now);
    assert.equal(reply.version, 3);
  }
  const state = normalizeNativeSourceAudioReply(fixture("-state"), query, now);
  assert.equal(state.encoding.channels, 1); assert.ok(Object.isFrozen(state.encoding.renditions[0]));
  assert.throws(() => normalizeNativeSourceAudioReply({ ...fixture("-state"), version: 2 }, { ...query, version: 2 }, now));
  const input = { requestVersion: 3, deviceFingerprint: "a".repeat(43), expectedProgramRevision: 1, expectedProgramEpoch: 2,
    action: "apply", trigger: "user-action", expectedAudioRevision: 2, sources: [], strategy: "balanced" };
  assert.deepEqual(normalizeNativeAudioDirectorInput(input), input);
  assert.throws(() => normalizeNativeAudioDirectorInput({ ...input, audioOutput: output }));
});
