import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeNativeAudioSelection, normalizeNativeSourceAudio, normalizeNativeSourceAudioQuery, normalizeNativeSourceAudioReply } from "../src/native-source-audio.js";
import { parseNativeSourceAudioReply } from "../src/native-source-audio-wire.js";
import { normalizeNativeAudioDirectorInput } from "../src/native-source-audio-director.js";
const fixture = name => JSON.parse(readFileSync(new URL(`../native-broadcast-packager/testdata/source-audio${name}.v2.json`, import.meta.url)));
const command = fixture(""), query = fixture("-query"), now = command.issuedAt;

test("audio v2 shares actual native contracts and rejects cross-version replies", () => {
  assert.deepEqual(normalizeNativeSourceAudio(command, now), command);
  assert.deepEqual(normalizeNativeSourceAudioQuery(query, now), query);
  for (const suffix of ["-state", "-applied", "-rejected"]) {
    const value = fixture(suffix), request = suffix === "-state" ? query : command;
    assert.deepEqual(normalizeNativeSourceAudioReply(value, request, now), value);
    assert.deepEqual(parseNativeSourceAudioReply(JSON.stringify(value)), value);
    assert.throws(() => normalizeNativeSourceAudioReply({ ...value, version: 1 }, request, now));
  }
  for (const strategy of ["unprocessed", "balanced", "speech-first", "screen-first"]) {
    assert.equal(normalizeNativeSourceAudio({ ...command, strategy, sources: [] }, now).strategy, strategy);
    assert.throws(() => normalizeNativeAudioSelection({ expectedAudioRevision: 2, sources: [], strategy }));
  }
  for (const strategy of [null, undefined, "automatic", {}, true]) assert.throws(() => normalizeNativeSourceAudio({ ...command, strategy }, now));
  assert.throws(() => normalizeNativeSourceAudio({ ...command, version: 1 }, now));
});

test("audio v2 observations deeply freeze bounded mix and actual encoding metadata", () => {
  const input = fixture("-state"), normalized = normalizeNativeSourceAudioReply(input, query, now);
  input.mix.strategy = "invalid"; input.encoding.renditions[0].targetBitsPerSecond = 0;
  assert.equal(normalized.mix.strategy, "speech-first"); assert.equal(normalized.encoding.renditions[0].targetBitsPerSecond, 64000);
  for (const value of [normalized.mix, normalized.encoding, normalized.encoding.renditions, normalized.encoding.renditions[0]]) assert.equal(Object.isFrozen(value), true);
  for (const nested of ["mix", "encoding"]) for (const key of Object.keys(fixture("-state")[nested])) {
    const missing = fixture("-state"); delete missing[nested][key];
    assert.throws(() => normalizeNativeSourceAudioReply(missing, query, now));
    const nil = fixture("-state"); nil[nested][key] = null;
    assert.throws(() => parseNativeSourceAudioReply(JSON.stringify(nil)));
  }
  for (const patch of [{ strategy: "secret" }, { peakQ15: -1 }, { microphoneGainQ15: 32769 }, { limiterGainQ15: 1.5 }, { decryptKey: "no" }]) {
    const bad = fixture("-state"); Object.assign(bad.mix, patch);
    assert.throws(() => normalizeNativeSourceAudioReply(bad, query, now));
  }
  for (const patch of [{ codec: "opus" }, { channels: 1 }, { sampleRate: 44100 }, { renditions: [] }, { dtx: true },
    { renditions: [{ id: "low", targetBitsPerSecond: 64000 }, { id: "low", targetBitsPerSecond: 32000 }] },
    { renditions: [{ id: "high", targetBitsPerSecond: 320001 }] }]) {
    const bad = fixture("-state"); Object.assign(bad.encoding, patch);
    assert.throws(() => normalizeNativeSourceAudioReply(bad, query, now));
  }
});

test("director v2 only accepts presentation strategy, never wire or source authority", () => {
  const input = { requestVersion: 2, deviceFingerprint: "a".repeat(43), expectedProgramRevision: 1, expectedProgramEpoch: 1, action: "query" };
  assert.deepEqual(normalizeNativeAudioDirectorInput(input), input);
  const apply = { ...input, action: "apply", trigger: "user-action", expectedAudioRevision: 2, sources: [], strategy: "balanced" };
  assert.deepEqual(normalizeNativeAudioDirectorInput(apply), apply);
  for (const patch of [{ strategy: null }, { requestVersion: 1 }, { trigger: "remote" }, { commandId: command.commandId },
    { leaseId: command.leaseId }, { sourceConsent: true }, { encoding: { codec: "opus" } }]) assert.throws(() => normalizeNativeAudioDirectorInput({ ...apply, ...patch }));
});

test("director v2 HTTP schemas cover query/apply and all projected outcomes without native authority", () => {
  const compile = name => new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(
    new URL(`../contracts/native-packager/source-audio-director-${name}.v2.schema.json`, import.meta.url))));
  const request = compile("request"), response = compile("response");
  const input = { requestVersion: 2, deviceFingerprint: "a".repeat(43), expectedProgramRevision: 1, expectedProgramEpoch: 1, action: "query" };
  const apply = { ...input, action: "apply", trigger: "user-action", expectedAudioRevision: 2, sources: [], strategy: "balanced" };
  for (const value of [input, apply]) {
    assert.equal(request(value), true, JSON.stringify(request.errors));
    assert.deepEqual(normalizeNativeAudioDirectorInput(value), value);
    for (const key of Object.keys(value)) {
      const absent = { ...value }; delete absent[key];
      assert.equal(request(absent), false, key);
      assert.equal(request({ ...value, [key]: null }), false, key);
    }
    assert.equal(request({ ...value, leaseId: command.leaseId }), false);
    assert.equal(request({ ...value, requestVersion: 1 }), false);
  }
  const { sources, mix, encoding } = fixture("-state");
  const scope = { audioControlVersion: 2, programId: command.programId, programRevision: 1, programEpoch: command.programEpoch,
    packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: command.assignmentId, fencingRevision: command.fencingRevision };
  for (const result of [{ outcome: "observed", observedAt: now, audioRevision: 2, sources, mix, encoding },
    { outcome: "applied", appliedAt: now, audioRevision: 3 }, { outcome: "rejected", observedAt: now, reasonCode: "AUDIO_NOT_APPLIED" }]) {
    const value = { ...scope, ...result };
    assert.equal(response(value), true, JSON.stringify(response.errors));
    for (const key of Object.keys(value)) {
      const absent = { ...value }; delete absent[key];
      assert.equal(response(absent), false, key);
      assert.equal(response({ ...value, [key]: null }), false, key);
    }
    assert.equal(response({ ...value, audioControlVersion: 1 }), false);
    assert.equal(response({ ...value, leaseId: command.leaseId }), false);
  }
});
