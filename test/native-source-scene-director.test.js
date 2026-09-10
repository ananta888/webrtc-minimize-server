import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { directNativeSourceScene, normalizeNativeSceneDirectorInput } from "../src/native-source-scene-director.js";

const now = 1800000000000, programId = "prg_aaaaaaaaaaaaaaaa", packagerId = "pkr_aaaaaaaaaaaaaaaa";
const input = { requestVersion: 1, action: "query", deviceFingerprint: "a".repeat(43), expectedProgramRevision: 4, expectedProgramEpoch: 2 };
const schemas = Object.fromEntries(["request", "response"].map(name => [name, new Ajv2020({ strict: true }).compile(JSON.parse(fs.readFileSync(
  new URL(`../contracts/native-packager/source-scene-director-${name}.v1.schema.json`, import.meta.url), "utf8")))]));
function fixture() {
  let member = { id: "a".repeat(16), creator: true, principal: "owner", deviceFingerprint: input.deviceFingerprint, roomId: "room-alpha" };
  const socket = {}, generation = {}, identity = {};
  const writer = { state: "live", programRevision: 4, programEpoch: 2, packagerRef: packagerId,
    fencingRevision: 3, leaseId: "lea_aaaaaaaaaaaaaaaa", expiresAt: now + 60000 };
  const assignment = { inputMode: "trusted-sframe-v1", assignmentId: "asn_aaaaaaaaaaaaaaaa", programId,
    programEpoch: 2, roomId: "room-alpha", leaseId: writer.leaseId, fencingRevision: 3, expiresAt: now + 50000 };
  const capability = { capabilityVersion: 2, sourcePrograms: true, agentVersion: "0.9.0", expiresAt: now + 30000 };
  const reply = { version: 1, type: "source-program-scene-state", programEpoch: 2, assignmentId: assignment.assignmentId,
    fencingRevision: 3, sceneRevision: 1, layout: "waiting-slate", observedAt: now, sourceLeaseIds: [], activeSourceLeaseId: "", availableSources: [] };
  let after = () => {};
  const args = { identity, ownerPrincipal: "owner", programId, input, getMember: () => member, clock: () => now,
    runtime: { nativeSourceWriterContext: () => writer }, assignments: { sourceContext: () => assignment },
    control: { sourceContext: () => ({ generation, capability }), socketFor: () => socket, connection: () => ({ ownerPrincipal: "owner" }) },
    broker: { async request(_selection, authorize) { authorize(now); queueMicrotask(() => after()); return reply; } } };
  return { args, writer, assignment, capability, reply, setAfter: v => { after = v; }, leave: () => { member = null; } };
}

test("v2 query negotiates explicitly supported scene state without disabling old agents", async () => {
  for (const modern of [false, true]) {
    const f = fixture(); f.args.input = { ...input, requestVersion: 2 };
    if (modern) {
      Object.assign(f.capability, { capabilityVersion: 6, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1, sourceSceneControlVersion: 2 });
      Object.assign(f.reply, { version: 2, sourceFits: [] });
    }
    const result = await directNativeSourceScene(f.args);
    assert.equal(result.sceneControlVersion, modern ? 2 : 1);
    assert.equal(Object.hasOwn(result, "sourceFits"), modern);
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(fs.readFileSync(
      new URL(`../contracts/native-packager/source-scene-director-response.v${modern ? 2 : 1}.schema.json`, import.meta.url))));
    assert.ok(validate(result));
  }
});

test("requested v2 apply cannot silently downgrade and negotiated capability changes invalidate replies", async () => {
  const f = fixture();
  f.args.input = { ...input, requestVersion: 2, action: "apply", trigger: "user-action", expectedSceneRevision: 1,
    layout: "grid", sourceLeaseIds: [], activeSourceLeaseId: "", sourceFits: [] };
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(fs.readFileSync(
    new URL("../contracts/native-packager/source-scene-director-request.v2.schema.json", import.meta.url))));
  assert.ok(validate(f.args.input)); assert.ok(validate({ ...input, requestVersion: 2 }));
  for (const patch of [{ sourceFits: null }, { sourceFits: ["unknown"] }, { sourceFits: undefined }, { extra: true }]) {
    assert.equal(validate({ ...f.args.input, ...patch }), false);
    assert.throws(() => normalizeNativeSceneDirectorInput({ ...f.args.input, ...patch }));
  }
  assert.throws(() => normalizeNativeSceneDirectorInput({ ...f.args.input, sourceFits: ["cover"] }), /invalid_native_scene_request/);
  await assert.rejects(directNativeSourceScene(f.args), /native_scene_unsupported/);
  Object.assign(f.capability, { capabilityVersion: 6, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1, sourceSceneControlVersion: 2 });
  await assert.rejects(directNativeSourceScene(f.args), /native_scene_reply_invalid/);
  const q = fixture(); q.args.input = { ...input, requestVersion: 2 };
  Object.assign(q.capability, f.capability); Object.assign(q.reply, { version: 2, sourceFits: [] });
  q.setAfter(() => { q.capability.capabilityVersion = 5; delete q.capability.sourceSceneControlVersion; });
  await assert.rejects(directNativeSourceScene(q.args), /native_scene_authority_changed/);
});

test("HTTP schemas agree with closed query/apply requests and projected observations", async () => {
  for (const value of [input, { ...input, action: "apply", trigger: "user-action", expectedSceneRevision: 1, layout: "grid",
    sourceLeaseIds: [], activeSourceLeaseId: "" }]) {
    assert.equal(schemas.request(value), true); assert.deepEqual(normalizeNativeSceneDirectorInput(value), value);
    for (const key of Object.keys(value)) {
      const bad = { ...value }; delete bad[key]; assert.equal(schemas.request(bad), false); assert.throws(() => normalizeNativeSceneDirectorInput(bad));
    }
  }
  const f = fixture(), result = await directNativeSourceScene(f.args);
  assert.equal(schemas.response(result), true, JSON.stringify(schemas.response.errors));
  assert.equal(Object.hasOwn(result, "leaseId"), false); assert.equal(Object.hasOwn(result, "commandId"), false);
  assert.equal(Object.hasOwn(result, "socket"), false); assert.equal(result.outcome, "observed");
  assert.equal(schemas.response({ ...result, authority: true }), false);
});

test("director rechecks authority after the awaited broker reply before returning HTTP metadata", async () => {
  for (const change of ["member", "revision", "epoch", "fence", "capability", "assignment"]) {
    const f = fixture();
    f.setAfter(() => {
      if (change === "member") f.leave();
      if (change === "revision") f.writer.programRevision++;
      if (change === "epoch") f.writer.programEpoch++;
      if (change === "fence") f.writer.fencingRevision++;
      if (change === "capability") f.capability.sourcePrograms = false;
      if (change === "assignment") f.assignment.assignmentId = "asn_bbbbbbbbbbbbbbbb";
    });
    await assert.rejects(directNativeSourceScene(f.args), /native_scene_/);
  }
});

test("legacy assignment, mismatched writer lease and non-live programs cannot enter scene control", async () => {
  for (const change of ["legacy", "lease", "room", "stopped", "old-agent"]) {
    const f = fixture();
    if (change === "legacy") f.assignment.inputMode = "legacy";
    if (change === "lease") f.assignment.leaseId = "lea_bbbbbbbbbbbbbbbb";
    if (change === "room") f.assignment.roomId = "room-other";
    if (change === "stopped") f.writer.state = "ended";
    if (change === "old-agent") f.capability.agentVersion = "0.8.0";
    await assert.rejects(directNativeSourceScene(f.args), /native_scene_/);
  }
});
