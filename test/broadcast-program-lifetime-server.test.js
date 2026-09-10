import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { broadcastSubjectRef, broadcastTenantRef } from "../src/broadcast-identifiers.js";
import { NativePackagerControlRegistry } from "../src/native-packager-control.js";

test("actual server ENV resource budget denies native activation while keeping the draft and health", async t => {
  const now = Date.now(), packagerId = "pkr_aaaaaaaaaaaaaaaa";
  const identity = { issuer: "https://synthetic.example/realm", subject: "owner", displayName: "Synthetic" };
  const principal = `${identity.issuer}|${identity.subject}`;
  const member = { principal, id: "0123456789abcdef", roomId: "room-alpha", creator: true, deviceFingerprint: "a".repeat(43) };
  const capability = { capabilityVersion: 1, agentId: packagerId, tenantId: broadcastTenantRef(identity.issuer),
    ownerSubjectRef: broadcastSubjectRef(identity), deviceRef: "dev_aaaaaaaaaaaaaaaa", agentVersion: "0.7.0", ffmpegVersion: "6.1.1",
    videoEncoders: ["libx264"], audioEncoders: ["aac"], hardwareClass: "medium", cpuClass: "medium", gpuClass: "none",
    uploadClass: "5-15mbit", energyClass: "ac", health: "healthy", maximumRenditions: 1,
    maximumPixelsPerSecond: 1280 * 720 * 30, consentedRoomIds: [member.roomId], observedAt: now, expiresAt: now + 30000 };
  const nativePackagers = new NativePackagerControlRegistry({ definitions: [] });
  t.mock.method(nativePackagers, "candidate", (owner, id) => {
    assert.equal(owner, principal); assert.equal(id, packagerId); return { id, online: true, capability };
  });
  const app = createAppServer({ env: { AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false", BROADCAST_NATIVE_ENCODER_SLOTS: "0" },
    broadcastGrantAuthority: { issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {} }, nativePackagers });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const programId = app.broadcastRuntime.createProgram(identity, member, {
    requestVersion: 1, roomId: member.roomId, title: "Synthetic", visibility: "private",
  }).control.programId;
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.throws(() => app.broadcastRuntime.prepareNativePublisher(identity, member, programId, {
      requestVersion: 1, trigger: "user-action", packagerId, sourceIds: ["src_aaaaaaaaaaaaaaaa"], requestedRenditions: 1,
      allowHardwareAcceleration: false,
    }, request => app.nativePackagerAssignments.admit(principal, packagerId, request)), /broadcast_temporarily_unavailable/);
  }
  assert.equal(app.broadcastRuntime.listMine(identity).owned[0].availability, "offline");
  assert.equal(app.nativePackagerAssignments.list(principal).length, 0);
  const health = await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200); await health.arrayBuffer();
});

test("actual server wiring caps prepare/renew and delivers a scoped stop without claiming an agent ACK", async t => {
  const now = 1_800_000_000_000, packagerId = "pkr_aaaaaaaaaaaaaaaa", sent = [];
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const identity = { issuer: "https://synthetic.example/realm", subject: "owner", displayName: "Synthetic" };
  const principal = `${identity.issuer}|${identity.subject}`;
  const member = { principal, id: "0123456789abcdef", roomId: "room-alpha", creator: true, deviceFingerprint: "a".repeat(43) };
  const capability = { capabilityVersion: 1, agentId: packagerId, tenantId: broadcastTenantRef(identity.issuer),
    ownerSubjectRef: broadcastSubjectRef(identity), deviceRef: "dev_aaaaaaaaaaaaaaaa", agentVersion: "0.7.0", ffmpegVersion: "6.1.1",
    videoEncoders: ["libx264"], audioEncoders: ["aac"], hardwareClass: "medium", cpuClass: "medium", gpuClass: "none",
    uploadClass: "5-15mbit", energyClass: "ac", health: "healthy", maximumRenditions: 1,
    maximumPixelsPerSecond: 1280 * 720 * 30, consentedRoomIds: [member.roomId], observedAt: now, expiresAt: now + 30_000 };
  const nativePackagers = new NativePackagerControlRegistry({ definitions: [] });
  t.mock.method(nativePackagers, "candidate", (owner, id) => {
    assert.equal(owner, principal); assert.equal(id, packagerId); return { id, online: true, capability };
  });
  t.mock.method(nativePackagers, "socketFor", id => {
    assert.equal(id, packagerId); return { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  });
  const app = createAppServer({ env: { AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false", BROADCAST_MAX_PROGRAM_RUNTIME_MS: "60000" },
    broadcastGrantAuthority: { issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {} },
    nativePackagers,
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const programId = app.broadcastRuntime.createProgram(identity, member, {
    requestVersion: 1, roomId: member.roomId, title: "Synthetic", visibility: "private",
  }).control.programId;
  const prepared = app.broadcastRuntime.prepareNativePublisher(identity, member, programId, {
    requestVersion: 1, trigger: "user-action", packagerId, sourceIds: ["src_aaaaaaaaaaaaaaaa"],
    requestedRenditions: 1, allowHardwareAcceleration: false,
  }, request => app.nativePackagerAssignments.admit(principal, packagerId, request));
  const first = app.nativePackagerAssignments.prepare(principal, packagerId, prepared.admission, prepared.lease, member.id);
  assert.equal(first.command.expiresAt, now + 60_000);
  t.mock.timers.setTime(now + 20_000);
  const renewal = app.nativePackagerAssignments.renew(packagerId);
  assert.equal(renewal.command.expiresAt, now + 60_000);
  app.broadcastRuntime.renewNativeOutput(renewal.resourceRef, packagerId, renewal.snapshot.fencingRevision, renewal.command.expiresAt);
  t.mock.timers.setTime(now + 60_000); t.mock.timers.tick(500);
  assert.equal(app.broadcastRuntime.nativeControl(identity, member, programId).state, "stopped");
  // The existing lease-expiry watchdog independently repeats the same fenced
  // stop once; it must neither create a new assignment nor claim a cleanup ACK.
  assert.equal(sent.length, 2); assert.ok(sent.every(value => value.type === "assignment-stop"));
  assert.equal(sent[0].assignmentId, first.snapshot.assignmentId);
  assert.equal(sent[0].programEpoch, first.snapshot.programEpoch);
  assert.equal(sent[0].fencingRevision, first.snapshot.fencingRevision);
  assert.equal(sent[0].reasonCode, "PROGRAM_RUNTIME_EXPIRED");
  assert.deepEqual(sent[1], { ...sent[0], reasonCode: "LEASE_EXPIRED" });
  assert.equal(app.nativePackagerAssignments.activeForProgram(programId).state, "draining", "sending stop is not an agent cleanup ACK");
  assert.equal(app.nativePackagerAssignments.renew(packagerId), null);
  t.mock.timers.tick(500); assert.equal(sent.length, 2);
  const health = await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200); await health.arrayBuffer();
  app.nativePackagerAssignments.acknowledge(packagerId, { version: 1, type: "assignment-status", assignmentId: first.snapshot.assignmentId,
    programEpoch: first.snapshot.programEpoch, fencingRevision: first.snapshot.fencingRevision,
    state: "stopped", reasonCode: "ASSIGNMENT_STOPPED", observedAt: Date.now() });
  assert.equal(app.nativePackagerAssignments.activeForProgram(programId), null);
});
