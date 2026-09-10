import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { NativeSourceSceneBroker } from "../src/native-source-scene-broker.js";
import { parseNativePackagerMessage } from "../src/native-packager-control.js";
import { supportsNativeSourceSceneV1 } from "../src/native-packager-policy.js";

const fixture = name => JSON.parse(fs.readFileSync(new URL(`../native-broadcast-packager/testdata/source-scene-${name}.v1.json`, import.meta.url)));
const query = fixture("query"), NOW = query.issuedAt;
const selection = { expectedSceneRevision: 1, layout: "grid", sourceLeaseIds: [], activeSourceLeaseId: "" };
function setup() {
  let now = NOW;
  const timers = new Set(), sent = [];
  const context = { ...query, packagerId: "pkr_aaaaaaaaaaaaaaaa", programRevision: 4,
    socket: {}, generation: {}, member: {}, expiresAt: NOW + 60000 };
  let current = context;
  const broker = new NativeSourceSceneBroker({ clock: () => now,
    schedule: callback => { timers.add(callback); return callback; }, cancel: callback => timers.delete(callback),
    send(socket, command) { sent.push({ socket, command }); return true; } });
  const authorize = () => current;
  return { broker, timers, sent, context, authorize, request: (value = null, signal) => broker.request(value, authorize, signal),
    tick: value => { now = value; for (const callback of timers) callback(); }, set: value => { current = value; } };
}
function reply(command, outcome = "state") {
  const original = fixture(outcome);
  return { ...original, ...Object.fromEntries(["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"]
    .map(k => [k, command[k]])) };
}

test("v2 broker preserves fits, exact reply version and capability-context fencing", async () => {
  for (const outcome of ["success", "old-reply", "capability-change"]) {
    const f = setup(); f.context.sceneControlVersion = 2;
    const fits = ["cover"], update = { ...selection, sourceLeaseIds: ["sls_aaaaaaaaaaaaaaaa"], sourceFits: fits };
    const pending = f.request(update), command = f.sent[0].command;
    fits[0] = "contain";
    assert.equal(command.version, 2); assert.deepEqual(command.sourceFits, ["cover"]);
    const response = { ...reply(command, "applied"), version: outcome === "old-reply" ? 1 : 2 };
    assert.deepEqual(parseNativePackagerMessage(Buffer.from(JSON.stringify(response))), response);
    if (outcome === "capability-change") f.set({ ...f.context, sceneControlVersion: 1 });
    f.broker.acknowledge(f.context.socket, response);
    if (outcome === "success") assert.equal((await pending).version, 2);
    else await assert.rejects(pending, /native_scene_(reply_invalid|authority_changed)/);
    assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1); f.broker.destroy();
  }
});

test("v2 query observes actual fits, while invalid or downgraded selections never send", async () => {
  const f = setup(); f.context.sceneControlVersion = 2;
  for (const sourceFits of [undefined, null, ["cover"], ["invalid"]]) {
    await assert.rejects(f.request({ ...selection, sourceFits }), /invalid_native_scene_selection/);
  }
  assert.equal(f.sent.length, 0);
  const pending = f.request(), command = f.sent[0].command;
  const response = { ...reply(command), version: 2, sourceFits: [] };
  assert.deepEqual(parseNativePackagerMessage(JSON.stringify(response)), response);
  f.broker.acknowledge(f.context.socket, response);
  assert.ok(Object.isFrozen((await pending).sourceFits));
  f.context.sceneControlVersion = 1;
  await assert.rejects(f.request({ ...selection, sourceFits: [] }), /invalid_native_scene_selection/);
  f.context.sceneControlVersion = 3;
  await assert.rejects(f.request(), /native_scene_unsupported/);
  assert.equal(f.sent.length, 1); f.broker.destroy();
});

test("scene reply wire is closed, bounded, UTF8/duplicate strict and shared with the native fixtures", () => {
  for (const name of ["state", "applied", "rejected"]) {
    const value = fixture(name), raw = JSON.stringify(value);
    assert.deepEqual(parseNativePackagerMessage(Buffer.from(raw)), value);
    for (const bad of [raw.replace('"version":1', '"version":1,"version":1'),
      raw.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      JSON.stringify({ ...value, extra: true }), raw + " ".repeat(16384), Buffer.concat([Buffer.from(raw), Buffer.from([255])])]) {
      assert.throws(() => parseNativePackagerMessage(bad));
    }
  }
});

test("scene support requires stable protocol generation and actual source-program capability", () => {
  for (const agentVersion of ["0.8.0", "0.9.0-beta", "unknown", undefined]) {
    assert.equal(supportsNativeSourceSceneV1({ capabilityVersion: 2, sourcePrograms: true, agentVersion }), false);
  }
  for (const agentVersion of ["0.9.0", "0.10.0", "1.0.0"]) {
    assert.equal(supportsNativeSourceSceneV1({ capabilityVersion: 2, sourcePrograms: true, agentVersion }), true);
    assert.equal(supportsNativeSourceSceneV1({ capabilityVersion: 1, sourcePrograms: true, agentVersion }), false);
    assert.equal(supportsNativeSourceSceneV1({ capabilityVersion: 2, sourcePrograms: false, agentVersion }), false);
  }
});

test("broker correlates actual query/apply/rejection and releases every timer without automatic retry", async () => {
  for (const kind of ["state", "applied", "rejected"]) {
    const f = setup(), result = f.request(kind === "state" ? null : selection);
    const { command } = f.sent[0];
    assert.equal(command.expiresAt, NOW + 4000);
    assert.equal(f.broker.acknowledge({}, reply(command, kind)), false);
    assert.equal(f.broker.acknowledge(f.context.socket, reply(command, kind)), true);
    assert.deepEqual(await result, reply(command, kind));
    assert.equal(f.broker.acknowledge(f.context.socket, reply(command, kind)), false);
    assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1);
    f.broker.destroy();
  }
});

test("broker rejects scope injection, same-packager concurrency and global request saturation", async () => {
  const f = setup();
  await assert.rejects(f.request({ ...selection, leaseId: "lea_bbbbbbbbbbbbbbbb" }), /invalid_native_scene_selection/);
  const first = f.request(); first.catch(() => {});
  await assert.rejects(f.request(), /native_scene_busy/);
  const jobs = [first];
  for (let i = 1; i < 128; i++) {
    const current = { ...f.context, socket: {}, packagerId: `pkr_${String(i).padStart(16, "0")}` };
    const job = f.broker.request(null, () => current); job.catch(() => {}); jobs.push(job);
  }
  await assert.rejects(f.broker.request(null, () => ({ ...f.context, packagerId: "pkr_bbbbbbbbbbbbbbbb" })), /native_scene_busy/);
  assert.equal(f.timers.size, 128); f.broker.destroy();
  assert.ok((await Promise.allSettled(jobs)).every(x => x.status === "rejected"));
  assert.equal(f.timers.size, 0);
});

test("every ownership dimension is checked again before admitting a reply", async () => {
  for (const key of ["socket", "generation", "member", "packagerId", "assignmentId", "programId", "programRevision", "programEpoch", "leaseId", "fencingRevision"]) {
    const f = setup(), result = f.request();
    const old = f.context[key];
    f.set({ ...f.context, [key]: typeof old === "object" ? {} : typeof old === "number" ? old + 1 : old + "b" });
    f.broker.acknowledge(f.context.socket, reply(f.sent[0].command));
    await assert.rejects(result, /native_scene_authority_changed/); assert.equal(f.timers.size, 0);
  }
});

test("authority polling, exact expiry, clock rollback, abort, disconnect and shutdown are terminal", async () => {
  for (const kind of ["authority", "expiry", "rollback", "abort", "disconnect", "destroy"]) {
    const f = setup(), controller = new AbortController(), result = f.request(null, controller.signal);
    if (kind === "authority") { f.set(null); f.tick(NOW + 100); }
    if (kind === "expiry") f.tick(NOW + 4000);
    if (kind === "rollback") f.tick(NOW - 1);
    if (kind === "abort") controller.abort();
    if (kind === "disconnect") f.broker.disconnect(f.context.socket);
    if (kind === "destroy") f.broker.destroy();
    await assert.rejects(result, /native_scene_/);
    assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1);
    assert.equal(f.broker.acknowledge(f.context.socket, reply(f.sent[0].command)), false);
  }
});

test("foreign fields and wrong reply scopes cannot produce an applied receipt", async () => {
  for (const patch of [{ leaseId: "lea_bbbbbbbbbbbbbbbb" }, { sceneRevision: 8 }, { extra: true }, { appliedAt: NOW + 4000 }]) {
    const f = setup(), result = f.request(selection);
    f.broker.acknowledge(f.context.socket, { ...reply(f.sent[0].command, "applied"), ...patch });
    await assert.rejects(result, /native_scene_reply_invalid/); assert.equal(f.timers.size, 0);
  }
});
