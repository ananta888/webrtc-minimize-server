import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { BroadcastProgramHistory } from "../src/broadcast-program-history.js";
import { BroadcastProgramHistoryQuery, normalizeProgramHistoryQuery } from "../src/broadcast-program-history-query.js";
const NOW = 1800000000000, tenant = "tn_aaaaaaaaaaaaaaaa", program = "prg_aaaaaaaaaaaaaaaa";
const record = (state = "live", extra = {}) => ({ snapshot: { machine: { scope: { tenantId: tenant, programId: program },
  program: { state, revision: 4, programEpoch: 2 } } }, ...extra });
const schema = Object.fromEntries(["request", "response"].map(n => [n, new Ajv({ strict: true }).compile(JSON.parse(fs.readFileSync(
  new URL(`../contracts/native-packager/program-history-${n}.v1.schema.json`, import.meta.url))))]));

test("history records only committed state/standby/handoff differences without retaining raw records", () => {
  const history = new BroadcastProgramHistory(), before = record("live", { token: "secret", caption: "private", sourceIds: ["hidden"] });
  history.observe(null, before, NOW); history.observe(before, before, NOW + 1);
  assert.equal(history.list(tenant, program, NOW + 1).length, 1);
  const pending = record("preparing", { pendingHandoff: {} });
  history.observe(before, pending, NOW + 2);
  const next = record("preparing"); history.observe(pending, next, NOW + 3);
  history.observe(next, record("live"), NOW + 4);
  history.observe(record("live"), record("live", { standbyPlan: { revision: 1, packagerIds: ["private-id"] } }), NOW + 5);
  const entries = history.list(tenant, program, NOW + 5);
  assert.deepEqual(entries.map(e => e.kind), ["standby-changed", "state-changed", "handoff-assigned", "handoff-begun", "state-changed", "registered"]);
  assert.equal(entries[0].standbyCount, 1); assert.ok(Object.isFrozen(entries)); assert.ok(entries.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(entries), /secret|private|hidden|tn_|prg_|key|token|caption|sourceId/);
  history.observe(pending, record("stopped"), NOW + 6);
  assert.equal(history.list(tenant, program, NOW + 6)[0].kind, "handoff-stopped");
});

test("history has bounded global/per-program retention, isolation and no global sequence leakage", () => {
  const history = new BroadcastProgramHistory(); let prior = record();
  history.observe(null, prior, NOW);
  for (let n = 1; n <= 300; n++) {
    const next = record(n % 2 ? "degraded" : "live"); history.observe(prior, next, NOW + n); prior = next;
  }
  const own = history.list(tenant, program, NOW + 300);
  assert.equal(own.length, 32); assert.equal(own.at(-1).occurredAt, NOW + 269);
  assert.deepEqual(history.list("tn_bbbbbbbbbbbbbbbb", program, NOW + 300), []);
  assert.deepEqual(history.list(tenant, "prg_bbbbbbbbbbbbbbbb", NOW + 300), []);
  for (let n = 0; n < 256; n++) {
    const other = record(); other.snapshot.machine.scope.programId = `prg_${String(n).padStart(16, "0")}`;
    history.observe(null, other, NOW + 301 + n);
  }
  assert.deepEqual(history.list(tenant, program, NOW + 600), []);
  assert.equal(history.list(tenant, "prg_0000000000000255", NOW + 900556).length, 0);
});

test("bad clock clears advisory history without authorizing or reordering anything", () => {
  const history = new BroadcastProgramHistory(); history.observe(null, record(), NOW);
  assert.equal(history.list(tenant, program, NOW - 1), null);
  assert.equal(history.observe(null, record(), NOW - 1), false);
  assert.deepEqual(history.list(tenant, program, NOW), []);
  assert.equal(history.observe(null, {}, NOW), false);
  assert.equal(history.observe({}, record(), NOW), false, "invalid prior state cannot masquerade as registration");
  assert.equal(history.observe(null, record("live", { standbyPlan: { packagerIds: { length: NaN } } }), NOW), false);
  history.destroy(); assert.equal(history.observe(null, record(), NOW + 1), false);
  assert.equal(history.list(tenant, program, NOW + 1), null);
});

test("query is closed, human/current-device gated, short-lived and bounded by membership rate", () => {
  let now = NOW, reads = 0;
  const input = { requestVersion: 1, deviceFingerprint: "a".repeat(43) };
  const member = { authenticated: true, creator: true, principal: "owner", deviceFingerprint: input.deviceFingerprint };
  const identity = { expiresAt: NOW + 120000 };
  const args = { input, identity, ownerPrincipal: "owner", programId: program, getMember: () => member,
    runtime: { nativeProgramHistory(i, m, id, time) { reads++; assert.equal(i, identity); assert.equal(m, member); assert.equal(id, program);
      assert.equal(time, now); return { programId: program, programRevision: 4, programEpoch: 2, events: [] }; } } };
  const query = new BroadcastProgramHistoryQuery({ clock: () => now });
  assert.ok(schema.request(input)); assert.ok(Object.isFrozen(normalizeProgramHistoryQuery(input)));
  for (const bad of [null, [], {}, { ...input, extra: 1 }, { ...input, requestVersion: 2 }, { ...input, deviceFingerprint: "bad" }]) {
    assert.equal(schema.request(bad), false); assert.throws(() => normalizeProgramHistoryQuery(bad));
  }
  for (const patch of [{ authenticated: false }, { creator: false }, { machine: true }, { principal: "other" }, { deviceFingerprint: "z".repeat(43) }]) {
    assert.throws(() => query.query({ ...args, getMember: () => ({ ...member, ...patch }) }), e => e.status === 403);
  }
  assert.equal(reads, 0);
  const first = query.query(args); assert.ok(schema.response(first)); assert.equal(first.complete, false); assert.equal(first.expiresAt, NOW + 5000);
  for (let n = 1; n < 12; n++) query.query(args);
  assert.throws(() => query.query(args), e => e.status === 429); assert.equal(reads, 12);
  now--; assert.throws(() => query.query(args), e => e.status === 503);
  now = NOW + 60000; identity.expiresAt = now + 100;
  assert.equal(query.query(args).expiresAt, now + 100);
  query.destroy(); assert.throws(() => query.query(args), e => e.status === 503);
});
