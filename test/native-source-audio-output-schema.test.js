import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const read = path => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const compile = name => new Ajv2020({ strict: true, allErrors: true }).compile(read("contracts/native-packager/" + name + ".schema.json"));
const assignment = read("native-broadcast-packager/testdata/source-program-assignment.v5.json");

test("v5 source assignment carries a closed independent output selection and cannot enter legacy schemas", () => {
  const validate = compile("assignment-prepare.v5");
  assert.equal(validate(assignment), true, JSON.stringify(validate.errors));
  for (const name of ["server-control.v1", "assignment-prepare.v2", "assignment-prepare.v3", "assignment-prepare.v4"]) {
    assert.equal(compile(name)(assignment), false);
  }
  for (const field of Object.keys(assignment.audioOutput)) {
    const value = structuredClone(assignment); delete value.audioOutput[field];
    assert.equal(validate(value), false);
    assert.equal(validate({ ...assignment, audioOutput: { ...assignment.audioOutput, [field]: null } }), false);
    const renamed = { ...assignment.audioOutput }; renamed[field.toUpperCase()] = renamed[field]; delete renamed[field];
    assert.equal(validate({ ...assignment, audioOutput: renamed }), false);
  }
  for (const audioOutput of [null, {}, [], { ...assignment.audioOutput, path: "/untrusted" },
    { ...assignment.audioOutput, codec: "opus" }, { ...assignment.audioOutput, sampleRate: 44100 },
    { ...assignment.audioOutput, channels: 3 }, { ...assignment.audioOutput, targetBitsPerSecond: 192001 }]) {
    assert.equal(validate({ ...assignment, audioOutput }), false);
  }
  const absent = structuredClone(assignment); delete absent.audioOutput;
  assert.equal(validate(absent), false);
});

test("output schema validates mono/stereo bounds independently of the video ladder", () => {
  const validate = compile("source-audio-output.v1");
  for (const channels of [1, 2]) for (const rate of [15999, 16000, 48000, 96000, 192000, 192001, 320000, 320001]) {
    const value = { codec: "aac", sampleRate: 48000, channels, targetBitsPerSecond: rate };
    assert.equal(validate(value), rate >= 16000 && rate <= (channels === 1 ? 192000 : 320000));
  }
});

for (const suffix of ["", "-query", "-state", "-applied", "-rejected"]) {
  test(`shared native audio v3${suffix} fixture validates without changing v1/v2 meaning`, () => {
    const name = "source-audio" + suffix;
    const value = read("native-broadcast-packager/testdata/" + name + ".v3.json");
    const validate = compile(name + ".v3");
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    for (const version of [1, 2]) assert.equal(compile(name + ".v" + version)(value), false);
    assert.equal(validate({ ...value, version: 4 }), false);
    for (const key of Object.keys(value)) {
      const absent = structuredClone(value); delete absent[key]; assert.equal(validate(absent), false, key);
      assert.equal(validate({ ...value, [key]: null }), false, key);
    }
  });
}

test("director audio v3 schemas use the negotiated version without exposing output mutation", () => {
  const request = compile("source-audio-director-request.v3"), response = compile("source-audio-director-response.v3");
  const input = { requestVersion: 3, deviceFingerprint: "a".repeat(43), expectedProgramRevision: 1, expectedProgramEpoch: 2, action: "query" };
  assert.equal(request(input), true, JSON.stringify(request.errors));
  assert.equal(request({ ...input, audioOutput: assignment.audioOutput }), false, "encoding is immutable during a program");
  const state = read("native-broadcast-packager/testdata/source-audio-state.v3.json");
  const result = { outcome: "observed", audioControlVersion: 3, programId: state.programId, programRevision: 1,
    programEpoch: state.programEpoch, packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: state.assignmentId,
    fencingRevision: state.fencingRevision, observedAt: state.observedAt, audioRevision: state.audioRevision,
    sources: state.sources, mix: state.mix, encoding: state.encoding };
  assert.equal(response(result), true, JSON.stringify(response.errors));
  assert.equal(response({ ...result, audioControlVersion: 2 }), false);
  assert.equal(compile("source-audio-director-response.v2")(result), false);
});
