import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeNativeSourceAudio, normalizeNativeSourceAudioQuery, normalizeNativeSourceAudioReply } from "../src/native-source-audio.js";
import { parseNativeSourceAudioReply } from "../src/native-source-audio-wire.js";

const load = name => JSON.parse(readFileSync(new URL(`../native-broadcast-packager/testdata/source-audio${name}.v1.json`, import.meta.url)));
const command = load(""), query = load("-query"), now = command.issuedAt;

test("native audio normalizers share Go fixtures and detach mutable selections", () => {
  const input = structuredClone(command), normalized = normalizeNativeSourceAudio(input, now);
  input.sources[0].muted = false;
  assert.equal(normalized.sources[0].muted, true);
  assert.equal(Object.isFrozen(normalized.sources[0]), true);
  assert.deepEqual(normalizeNativeSourceAudioQuery(query, now), query);
  for (const suffix of ["-applied", "-state", "-rejected"]) {
    const reply = load(suffix), request = suffix === "-state" ? query : command;
    assert.deepEqual(normalizeNativeSourceAudioReply(reply, request, now), reply);
    assert.deepEqual(parseNativeSourceAudioReply(Buffer.from(JSON.stringify(reply))), reply);
  }
});

test("native audio requests reject unknown/null fields, duplicate leases and invalid bounds", () => {
  for (const [value, normalize] of [[command, normalizeNativeSourceAudio], [query, normalizeNativeSourceAudioQuery]]) {
    for (const key of Object.keys(value)) {
      const absent = structuredClone(value); delete absent[key];
      assert.throws(() => normalize(absent, now));
      assert.throws(() => normalize({ ...value, [key]: null }, now));
    }
    for (const extra of [{ extra: true }, { version: 2 }, { commandId: "scn_aaaaaaaaaaaaaaaa" },
      { programEpoch: 0 }, { fencingRevision: 1.5 }, { expiresAt: now + 4001 }]) assert.throws(() => normalize({ ...value, ...extra }, now));
    for (const time of [0, NaN, Infinity, now - 1001, value.expiresAt]) assert.throws(() => normalize(value, time));
  }
  for (const extra of [{ leftGainQ15: -1 }, { rightGainQ15: 32769 }, { muted: null }, { sourceKind: "microphone" }]) {
    const value = structuredClone(command); Object.assign(value.sources[0], extra);
    assert.throws(() => normalizeNativeSourceAudio(value, now));
  }
  for (const entries of [[], [command.sources[0], { ...command.sources[0], muted: false }],
    Array.from({ length: 81 }, (_, i) => ({ ...command.sources[0], sourceLeaseId: `sls_${String(i).padStart(16, "0")}` }))]) {
    assert.throws(() => normalizeNativeSourceAudio({ ...command, sources: entries }, now));
  }
});

test("native audio replies require exact scope, fresh request and correlated revision", () => {
  for (const suffix of ["-applied", "-state", "-rejected"]) {
    const reply = load(suffix), request = suffix === "-state" ? query : command;
    const at = suffix === "-applied" ? "appliedAt" : "observedAt";
    for (const [key, value] of Object.entries({ commandId: "aud_bbbbbbbbbbbbbbbb", assignmentId: "asn_bbbbbbbbbbbbbbbb",
      programId: "prg_bbbbbbbbbbbbbbbb", programEpoch: 2, leaseId: "lea_bbbbbbbbbbbbbbbb", fencingRevision: 2 })) {
      assert.throws(() => normalizeNativeSourceAudioReply({ ...reply, [key]: value }, request, now));
    }
    for (const timestamp of [now - 1001, now + 1001, request.expiresAt]) assert.throws(() => normalizeNativeSourceAudioReply({ ...reply, [at]: timestamp }, request, now));
    assert.throws(() => normalizeNativeSourceAudioReply(reply, request, request.expiresAt));
    assert.throws(() => normalizeNativeSourceAudioReply({ ...reply, token: "private" }, request, now));
  }
  assert.throws(() => normalizeNativeSourceAudioReply({ ...load("-applied"), audioRevision: 4 }, command, now));
  assert.throws(() => normalizeNativeSourceAudioReply({ ...load("-rejected"), reasonCode: "RETRY_WITHOUT_CONSENT" }, command, now));
  const state = load("-state"); state.sources.push({ ...state.sources[0], muted: false });
  assert.throws(() => normalizeNativeSourceAudioReply(state, query, now));
  assert.throws(() => normalizeNativeSourceAudioReply(load("-applied"), query, now));
});

test("native audio wire parser rejects raw ambiguity and never forwards payload diagnostics", () => {
  const raw = JSON.stringify(load("-state"));
  for (const invalid of [raw.replace('"version":1', '"version":1,"ver\\u0073ion":1'),
    raw.replace('"muted":true', '"muted":true,"mut\\u0065d":false'), raw + " {}", " ".repeat(16385),
    Buffer.concat([Buffer.from([255]), Buffer.from(raw)]), raw.replace('"sourceKind":"microphone"', '"sourceKind":"SECRET_CANARY"')]) {
    assert.throws(() => parseNativeSourceAudioReply(invalid), { message: "invalid_native_source_audio_reply" });
  }
});
