import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { BroadcastPlaybackObservation, normalizePlaybackObservation } from "../src/broadcast-playback-observation.js";
const schemas = Object.fromEntries(["request", "response"].map(name => [name, new Ajv({ strict: true }).compile(JSON.parse(fs.readFileSync(
  new URL(`../contracts/native-packager/playback-capacity-${name}.v1.schema.json`, import.meta.url))))]));
function fixture() {
  let now = 1800000000000, reads = 0;
  const input = { requestVersion: 1, deviceFingerprint: "a".repeat(43), expectedProgramRevision: 4, expectedProgramEpoch: 2, additionalSessions: 20 };
  const member = { principal: "owner", deviceFingerprint: input.deviceFingerprint, authenticated: true, creator: true };
  const writer = { state: "live", programRevision: 4, programEpoch: 2, tenantId: "tn_aaaaaaaaaaaaaaaa", expiresAt: now + 60000 };
  const identity = { expiresAt: now + 60000 };
  const observer = new BroadcastPlaybackObservation({ clock: () => now });
  const args = { input, identity, ownerPrincipal: "owner", programId: "prg_aaaaaaaaaaaaaaaa", getMember: () => member,
    runtime: { nativeSourceWriterContext(i, m, p, time) {
      assert.equal(i, identity); assert.equal(m, member); assert.equal(p, args.programId); assert.equal(time, now); return writer;
    } }, sessions: { inspectProgramCapacity(scope) {
      reads++; assert.deepEqual(scope, { tenantId: writer.tenantId, programId: args.programId, additionalSessions: input.additionalSessions, now });
      return { programSessions: 3, programLimit: 500, perAudienceLimit: 4, additionalSessions: 20, sharedBudgetsFit: true };
    } } };
  return { input, member, writer, identity, observer, args, reads: () => reads, advance: n => { now += n; } };
}
test("closed request/response, bounded lifetime and no private context disclosure", () => {
  const f = fixture(); assert.ok(schemas.request(f.input)); normalizePlaybackObservation(f.input);
  for (const field of Object.keys(f.input)) {
    const bad = { ...f.input }; delete bad[field];
    assert.equal(schemas.request(bad), false); assert.throws(() => normalizePlaybackObservation(bad));
    bad[field] = null; assert.equal(schemas.request(bad), false); assert.throws(() => normalizePlaybackObservation(bad));
  }
  for (const patch of [{ extra: 1 }, { additionalSessions: 10001 }, { additionalSessions: 0 }, { expectedProgramEpoch: 1.5 },
    { requestVersion: 2 }, { deviceFingerprint: "wrong" }, { expectedProgramRevision: 9007199254740992 }]) {
    assert.equal(schemas.request({ ...f.input, ...patch }), false);
    assert.throws(() => normalizePlaybackObservation({ ...f.input, ...patch }));
  }
  const result = f.observer.query(f.args); assert.ok(schemas.response(result)); assert.ok(Object.isFrozen(result));
  assert.equal(result.expiresAt - result.observedAt, 5000); assert.equal(result.reserved, false);
  for (const field of ["tenantId", "ownerPrincipal", "deviceFingerprint", "token", "deploymentSessions", "tenantSessions"]) {
    assert.equal(field in result, false); assert.equal(schemas.response({ ...result, [field]: 1 }), false);
  }
  f.identity.expiresAt = result.observedAt + 300; assert.equal(f.observer.query(f.args).expiresAt, f.identity.expiresAt);
  f.writer.expiresAt = result.observedAt + 100; assert.equal(f.observer.query(f.args).expiresAt, f.writer.expiresAt);
});
test("no store inspection without current authenticated creator, matching revision and live writer", () => {
  for (const mutate of [f => { f.member.authenticated = false; }, f => { f.member.creator = false; },
    f => { f.member.machine = true; }, f => { f.member.principal = "other"; }, f => { f.member.deviceFingerprint = "b".repeat(43); },
    f => { f.args.getMember = () => null; }, f => { f.identity.expiresAt = 1; }, f => { f.writer.expiresAt = 1; },
    f => { f.writer.programRevision++; }, f => { f.writer.programEpoch++; }, f => { f.writer.state = "stopped"; },
    f => { f.args.runtime.nativeSourceWriterContext = () => { throw new Error("not_owner"); }; }]) {
    const f = fixture(); mutate(f); assert.throws(() => f.observer.query(f.args)); assert.equal(f.reads(), 0);
  }
});
test("bounded membership rate and clock rollback precede store reads; teardown closes port", () => {
  const f = fixture();
  for (let n = 0; n < 12; n++) f.observer.query(f.args);
  assert.throws(() => f.observer.query(f.args), e => e.status === 429); assert.equal(f.reads(), 12);
  f.advance(-1); assert.throws(() => f.observer.query(f.args), /clock_invalid/);
  f.identity.expiresAt += 60000; f.writer.expiresAt += 60000; f.advance(60001);
  f.observer.query(f.args); assert.equal(f.reads(), 13);
  f.observer.destroy(); assert.throws(() => f.observer.query(f.args), e => e.status === 503);
});
