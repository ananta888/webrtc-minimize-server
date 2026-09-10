import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { NativeSourceLabels, normalizeNativeSourceLabelsInput } from "../src/native-source-labels.js";

const schemas = Object.fromEntries(["request", "response"].map(name => [name, new Ajv({ strict: true }).compile(JSON.parse(fs.readFileSync(
  new URL(`../contracts/native-packager/source-labels-${name}.v1.schema.json`, import.meta.url))))]));
function fixture() {
  let now = 1800000000000, reads = 0;
  const input = { requestVersion: 1, deviceFingerprint: "a".repeat(43), expectedProgramRevision: 4, expectedProgramEpoch: 2,
    expectedPackagerId: "pkr_aaaaaaaaaaaaaaaa", expectedAssignmentId: "asn_aaaaaaaaaaaaaaaa", expectedFencingRevision: 3,
    sourceLeaseIds: ["sls_aaaaaaaaaaaaaaaa"] };
  const member = { principal: "owner", deviceFingerprint: input.deviceFingerprint, roomId: "room-alpha" };
  const writer = { state: "live", programRevision: 4, programEpoch: 2, packagerRef: input.expectedPackagerId,
    fencingRevision: 3, leaseId: "lea_aaaaaaaaaaaaaaaa", expiresAt: now + 60000 };
  const assignment = { inputMode: "trusted-sframe-v1", assignmentId: input.expectedAssignmentId, programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 2, roomId: member.roomId, leaseId: writer.leaseId, fencingRevision: 3, expiresAt: now + 60000 };
  const capability = { capabilityVersion: 2, sourcePrograms: true, agentVersion: "0.9.0", expiresAt: now + 60000 };
  const rows = Object.freeze([Object.freeze({ sourceLeaseId: input.sourceLeaseIds[0], publisherPeerId: "b".repeat(16), sourceKind: "camera" })]);
  const socket = {}, generation = {}, labels = new NativeSourceLabels({ clock: () => now });
  const args = { identity: {}, ownerPrincipal: member.principal, programId: assignment.programId, input, getMember: () => member,
    runtime: { nativeSourceWriterContext: () => writer }, assignments: { sourceContext: () => assignment },
    control: { sourceContext: () => ({ generation, capability }), socketFor: () => socket, connection: () => ({ ownerPrincipal: "owner" }) },
    sources: { publisherBindings(context, ids) {
      reads++;
      assert.deepEqual(context, { roomId: member.roomId, programId: assignment.programId, programEpoch: 2,
        packagerId: input.expectedPackagerId, assignmentId: input.expectedAssignmentId, writerLeaseId: writer.leaseId, fencingRevision: 3 });
      assert.deepEqual(ids, input.sourceLeaseIds); return rows;
    } } };
  return { input, args, member, writer, assignment, capability, labels, rows, reads: () => reads, advance: ms => { now += ms; } };
}

test("closed label schemas and normalizer agree, bounded output excludes private writer context", () => {
  const f = fixture();
  assert.ok(schemas.request(f.input));
  const normalized = normalizeNativeSourceLabelsInput(f.input);
  assert.ok(Object.isFrozen(normalized)); assert.ok(Object.isFrozen(normalized.sourceLeaseIds));
  const eighty = { ...f.input, sourceLeaseIds: Array.from({ length: 80 }, (_, i) => `sls_${String(i).padStart(16, "0")}`) };
  assert.ok(schemas.request(eighty)); assert.equal(normalizeNativeSourceLabelsInput(eighty).sourceLeaseIds.length, 80);
  for (const key of Object.keys(f.input)) {
    const bad = { ...f.input }; delete bad[key];
    assert.equal(schemas.request(bad), false); assert.throws(() => normalizeNativeSourceLabelsInput(bad));
  }
  for (const patch of [{ extra: true }, { requestVersion: 2 }, { expectedProgramEpoch: 0 }, { expectedFencingRevision: 1.5 },
    { expectedProgramRevision: Number.MAX_SAFE_INTEGER + 1 }, { expectedPackagerId: "wrong" }, { expectedAssignmentId: "wrong" },
    { sourceLeaseIds: null }, { sourceLeaseIds: Array(81).fill(f.input.sourceLeaseIds[0]) },
    { sourceLeaseIds: [f.input.sourceLeaseIds[0], f.input.sourceLeaseIds[0]] }, { sourceLeaseIds: ["wrong"] }]) {
    assert.equal(schemas.request({ ...f.input, ...patch }), false);
    assert.throws(() => normalizeNativeSourceLabelsInput({ ...f.input, ...patch }));
  }
  const result = f.labels.query(f.args);
  assert.ok(schemas.response(result), JSON.stringify(schemas.response.errors)); assert.ok(Object.isFrozen(result));
  assert.equal(result.bindings, f.rows); assert.equal(f.reads(), 1);
  for (const key of ["leaseId", "writerLeaseId", "principal", "deviceFingerprint", "socket", "roomId", "generation", "name"]) {
    assert.equal(Object.hasOwn(result, key), false);
    assert.equal(schemas.response({ ...result, [key]: "unexpected" }), false);
  }
});

test("label projection requires current human device, live scoped writer, capability and connection before lookup", () => {
  const mutations = [f => { f.args.getMember = () => null; }, f => { f.member.machine = true; },
    f => { f.member.principal = "foreign"; }, f => { f.member.deviceFingerprint = "b".repeat(43); },
    f => { f.writer.state = "ended"; }, f => { f.writer.programRevision++; }, f => { f.writer.programEpoch++; },
    f => { f.input.expectedPackagerId = "pkr_bbbbbbbbbbbbbbbb"; }, f => { f.input.expectedAssignmentId = "asn_bbbbbbbbbbbbbbbb"; },
    f => { f.input.expectedFencingRevision++; }, f => { f.assignment.inputMode = "legacy"; },
    f => { f.assignment.leaseId = "lea_bbbbbbbbbbbbbbbb"; }, f => { f.assignment.roomId = "room-beta"; },
    f => { f.capability.sourcePrograms = false; }, f => { f.args.control.socketFor = () => null; },
    f => { f.args.control.connection = () => ({ ownerPrincipal: "foreign" }); }, f => { f.advance(60000); }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.throws(() => f.labels.query(f.args), /native_/); assert.equal(f.reads(), 0);
  }
});

test("label rate budget is bound to membership, rejects before lookup and does not expire backwards", () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.labels.query(f.args);
  assert.throws(() => f.labels.query(f.args), error => error.status === 429); assert.equal(f.reads(), 20);
  f.advance(-1); assert.throws(() => f.labels.query(f.args), /clock_invalid/); assert.equal(f.reads(), 20);
  f.advance(10001); f.labels.query(f.args); assert.equal(f.reads(), 21);
  f.labels.destroy(); assert.throws(() => f.labels.query(f.args), error => error.status === 503);
});
