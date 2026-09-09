import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NativeSourceAudioBroker } from "../src/native-source-audio-broker.js";
import { parseNativePackagerMessage } from "../src/native-packager-control.js";

const fixture = name => JSON.parse(readFileSync(new URL(`../native-broadcast-packager/testdata/source-audio${name}.v1.json`, import.meta.url)));
const base = fixture(""), now = base.issuedAt;
const selection = { expectedAudioRevision: base.expectedAudioRevision, sources: base.sources };
function setup() {
  let clock = now;
  const timers = new Set(), sent = [];
  const context = { ...base, packagerId: "pkr_aaaaaaaaaaaaaaaa", programRevision: 1,
    socket: {}, generation: Object.freeze({}), member: {}, expiresAt: now + 60000 };
  let current = context;
  const broker = new NativeSourceAudioBroker({ clock: () => clock, send: (socket, command) => { sent.push({ socket, command }); return true; },
    schedule: cb => { timers.add(cb); return cb; }, cancel: cb => timers.delete(cb) });
  return { broker, context, timers, sent, request: (value = null, signal) => broker.request(value, () => current, signal),
    set: value => { current = value; }, tick: at => { clock = at; for (const cb of timers) cb(); } };
}
function reply(command, suffix = "-state") {
  return { ...fixture(suffix), ...Object.fromEntries(["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"].map(k => [k, command[k]])) };
}

test("audio broker correlates shared wire replies once without retry or leaked timers", async () => {
  for (const suffix of ["-state", "-applied", "-rejected"]) {
    const f = setup(), result = f.request(suffix === "-state" ? null : selection), command = f.sent[0].command;
    const response = parseNativePackagerMessage(JSON.stringify(reply(command, suffix)));
    assert.equal(command.expiresAt, now + 4000);
    assert.equal(f.broker.acknowledge({}, response), false);
    assert.equal(f.broker.acknowledge(f.context.socket, response), true);
    assert.deepEqual(await result, response);
    assert.equal(f.broker.acknowledge(f.context.socket, response), false);
    assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1); f.broker.destroy();
  }
});

test("audio broker v2 correlates strategy commands and never accepts a v1 downgrade", async () => {
  for (const suffix of ["-state", "-applied", "-rejected"]) {
    const f = setup(), selected = suffix === "-state" ? null : { ...selection, strategy: "speech-first" };
    const pending = f.broker.request(selected, () => f.context, undefined, 2), command = f.sent[0].command;
    assert.equal(command.version, 2);
    const fixture = JSON.parse(readFileSync(new URL(`../native-broadcast-packager/testdata/source-audio${suffix}.v2.json`, import.meta.url)));
    const response = { ...fixture, commandId: command.commandId };
    f.broker.acknowledge(f.context.socket, response);
    assert.deepEqual(await pending, response); assert.equal(f.timers.size, 0); f.broker.destroy();
  }
  const f = setup(), pending = f.broker.request(null, () => f.context, undefined, 2);
  f.broker.acknowledge(f.context.socket, reply(f.sent[0].command));
  await assert.rejects(pending, /native_audio_reply_invalid/); assert.equal(f.timers.size, 0); f.broker.destroy();
});

test("audio broker rechecks every authoritative identity before accepting a reply", async () => {
  for (const key of ["socket", "generation", "member", "packagerId", "assignmentId", "programId", "programRevision", "programEpoch", "leaseId", "fencingRevision"]) {
    const f = setup(), result = f.request();
    f.set({ ...f.context, [key]: typeof f.context[key] === "object" ? {} : typeof f.context[key] === "number" ? 2 : "changed" });
    f.broker.acknowledge(f.context.socket, reply(f.sent[0].command));
    await assert.rejects(result, /native_audio_authority_changed/);
    assert.equal(f.timers.size, 0); f.broker.destroy();
  }
});

test("audio broker bounds pending capacity and never accepts authority in a selection", async () => {
  const f = setup();
  await assert.rejects(f.request({ ...selection, leaseId: base.leaseId }), /invalid_native_audio_selection/);
  const jobs = [f.request()]; jobs[0].catch(() => {});
  await assert.rejects(f.request(), /native_audio_busy/);
  for (let i = 1; i < 128; i++) {
    const context = { ...f.context, socket: {}, packagerId: `pkr_${String(i).padStart(16, "0")}` };
    const job = f.broker.request(null, () => context); job.catch(() => {}); jobs.push(job);
  }
  await assert.rejects(f.broker.request(null, () => ({ ...f.context, packagerId: "pkr_bbbbbbbbbbbbbbbb" })), /native_audio_busy/);
  assert.equal(f.timers.size, 128); f.broker.destroy();
  assert.ok((await Promise.allSettled(jobs)).every(result => result.status === "rejected"));
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.request(), /native_audio_cancelled/);
});

test("audio broker retains the original context even if its caller mutates the returned object", async () => {
  const f = setup(), result = f.request();
  f.context.programRevision++;
  f.broker.acknowledge(f.context.socket, reply(f.sent[0].command));
  await assert.rejects(result, /native_audio_authority_changed/);
  assert.equal(f.timers.size, 0); f.broker.destroy();
});

test("audio broker closes on expiry, clock rollback, abort, disconnect and malformed receipts", async () => {
  for (const reason of ["expiry", "rollback", "abort", "disconnect", "malformed", "authority"]) {
    const f = setup(), controller = new AbortController(), result = f.request(null, controller.signal);
    if (reason === "expiry") f.tick(now + 4000);
    if (reason === "rollback") f.tick(now - 1);
    if (reason === "abort") controller.abort();
    if (reason === "disconnect") f.broker.disconnect(f.context.socket);
    if (reason === "authority") { f.set({ ...f.context, expiresAt: NaN }); f.tick(now); }
    if (reason === "malformed") f.broker.acknowledge(f.context.socket, { ...reply(f.sent[0].command), audioRevision: 0 });
    await assert.rejects(result, /native_audio_/); assert.equal(f.timers.size, 0); f.broker.destroy();
  }
});

test("audio broker fences synchronous scheduler completion and failed transport", async () => {
  const f = setup(); let at = now, cancelled = 0, sent = 0;
  const broker = new NativeSourceAudioBroker({ clock: () => at, send: () => { sent++; return true; },
    schedule: callback => { at += 4000; callback(); return 42; }, cancel: () => { cancelled++; } });
  await assert.rejects(broker.request(null, () => f.context), /native_audio_expired/);
  assert.equal(sent, 0); assert.equal(cancelled, 1); broker.destroy(); f.broker.destroy();
  for (const send of [() => false, () => { throw new Error("SECRET_CANARY"); }]) {
    const g = setup(), timers = new Set();
    const failed = new NativeSourceAudioBroker({ clock: () => now, send,
      schedule: cb => { timers.add(cb); return cb; }, cancel: cb => timers.delete(cb) });
    await assert.rejects(failed.request(null, () => g.context), { message: "native_audio_delivery_failed" });
    assert.equal(timers.size, 0); failed.destroy(); g.broker.destroy();
  }
});
