import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { broadcastTenantRef } from "../src/broadcast-identifiers.js";
import { loadConfig } from "../src/config.js";

const NOW = 1_800_000_000_000, PACKAGER = "pkr_aaaaaaaaaaaaaaaa";
function fixture(maxProgramRuntimeMs = 60_000) {
  let now = NOW;
  const expired = [], revoked = [], identity = { issuer: "https://identity.example/realm", subject: "owner", displayName: "Synthetic" };
  const member = { principal: `${identity.issuer}|${identity.subject}`, roomId: "room-alpha", creator: true,
    deviceFingerprint: "a".repeat(43), id: "0123456789abcdef" };
  const runtime = new BroadcastRuntimeRegistry({ clock: () => now, maxProgramRuntimeMs,
    onProgramExpired: value => expired.push(value),
    grantAuthority: { issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch(...args) { revoked.push(args); } },
  });
  const programId = runtime.createProgram(identity, member, {
    requestVersion: 1, roomId: member.roomId, title: "Synthetic", visibility: "private",
  }).control.programId;
  const start = (admit = value => value) => runtime.prepareNativeSourceProgram(identity, member, programId, {
    requestVersion: 1, trigger: "user-action", packagerId: PACKAGER, inputMode: "trusted-sframe-v1",
    requestedRenditions: 1, allowHardwareAcceleration: false,
  }, admit);
  return { runtime, member, identity, programId, expired, revoked, start, now: value => { now = value; },
    control: () => runtime.nativeControl(identity, member, programId),
    context: () => runtime.nativeSourceWriterContext(identity, member, programId),
    ready: prepared => runtime.markNativeOutputReady(prepared.admission.resourceRef, PACKAGER, prepared.lease.fencingRevision),
    renew: (prepared, expiresAt) => runtime.renewNativeOutput(prepared.admission.resourceRef, PACKAGER,
      prepared.lease.fencingRevision, expiresAt),
  };
}

test("native renewals cannot extend the absolute program budget and boundary expires once", () => {
  const f = fixture(), prepared = f.start(); f.ready(prepared);
  f.now(NOW + 30_000); f.renew(prepared, NOW + 90_000);
  assert.equal(f.context().expiresAt, NOW + 60_000);
  f.now(NOW + 59_999); assert.equal(f.control().state, "live"); assert.equal(f.expired.length, 0);
  f.now(NOW + 60_000); f.runtime.prune();
  assert.equal(f.control().state, "stopped"); assert.equal(f.expired.length, 1);
  assert.equal(f.expired[0].principal, f.member.principal); assert.equal(f.expired[0].programId, f.programId);
  assert.equal(f.expired[0].reasonCode, "PROGRAM_RUNTIME_EXPIRED");
  assert.throws(f.context); assert.throws(() => f.renew(prepared, NOW + 120_000));
  assert.throws(() => f.ready(prepared));
  const revoked = f.revoked.length; f.runtime.prune();
  assert.equal(f.expired.length, 1); assert.equal(f.revoked.length, revoked);
});

test("draft age and rejected admission do not consume an active program lifetime", () => {
  const f = fixture(); f.now(NOW + 120_000); f.runtime.prune();
  assert.equal(f.runtime.listMine(f.identity).owned[0].availability, "offline");
  assert.throws(() => f.start(() => { throw new Error("synthetic_denial"); }), /synthetic_denial/);
  f.now(NOW + 180_000); const prepared = f.start(); f.ready(prepared);
  assert.equal(f.context().expiresAt, NOW + 240_000);
  f.now(NOW + 240_000); f.runtime.prune(); assert.equal(f.control().state, "stopped");
});

test("source authority expires synchronously without waiting for maintenance", () => {
  const f = fixture(), prepared = f.start(); f.ready(prepared);
  f.now(NOW + 30_000); f.renew(prepared, NOW + 90_000); f.now(NOW + 60_000);
  assert.throws(f.context); assert.equal(f.control().state, "stopped");
  assert.equal(f.expired.length, 1);
});

for (const time of [NOW - 1, NaN, Infinity]) test(`invalid/backward time ${time} cannot revive a program`, () => {
  const f = fixture(), prepared = f.start(); f.ready(prepared);
  f.now(time); f.runtime.prune(); f.now(NOW);
  assert.equal(f.control().state, "stopped"); assert.equal(f.expired.length, 1);
  assert.throws(() => f.ready(prepared));
});

test("default program lifetime is four hours and invalid operator/runtime values fail closed", () => {
  assert.equal(loadConfig({}).broadcastMaxProgramRuntimeMs, 14_400_000);
  for (const value of [0, 59_999, 86_400_001, 1.5, NaN, Infinity, "60000", null]) {
    assert.throws(() => fixture(value));
  }
  for (const value of ["0", "59999", "86400001", "1.5", "garbage", ""]) {
    assert.throws(() => loadConfig({ BROADCAST_MAX_PROGRAM_RUNTIME_MS: value }));
  }
  for (const value of [60_000, 14_400_000, 86_400_000]) {
    assert.equal(loadConfig({ BROADCAST_MAX_PROGRAM_RUNTIME_MS: String(value) }).broadcastMaxProgramRuntimeMs, value);
  }
});

test("internal lease deadline resolution is scoped to the current tenant, program and epoch", () => {
  const f = fixture(), prepared = f.start(), scope = { tenantId: broadcastTenantRef(f.identity.issuer),
    programId: f.programId, programEpoch: prepared.program.programEpoch };
  assert.equal(f.runtime.programLeaseDeadline(scope, NOW), NOW + 60_000);
  for (const patch of [{ tenantId: "tn_bbbbbbbbbbbbbbbb" }, { programId: "prg_bbbbbbbbbbbbbbbb" },
    { programEpoch: scope.programEpoch + 1 }, { extra: true }]) assert.equal(f.runtime.programLeaseDeadline({ ...scope, ...patch }, NOW), null);
  f.runtime.stopProgram(f.identity, f.programId);
  assert.equal(f.runtime.programLeaseDeadline(scope, NOW), null);
});

test("repeated output transitions retain capacity for expiry and terminal cleanup", () => {
  const f = fixture(), prepared = f.start(); f.ready(prepared);
  let limited = false;
  for (let i = 0; i < 300; i++) {
    try {
      if (i % 2 === 0) f.runtime.markNativeOutputUnavailable(prepared.admission.resourceRef, PACKAGER, prepared.lease.fencingRevision);
      else f.ready(prepared);
    } catch (error) { assert.equal(error.code, "broadcast_program_cleanup_capacity"); limited = true; break; }
  }
  assert.equal(limited, true);
  f.now(NOW + 60_000); assert.doesNotThrow(() => f.runtime.prune());
  assert.equal(f.control().state, "stopped"); assert.equal(f.expired.length, 1);
});
