import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { NativePackagerEnrollmentStore } from "../src/native-packager-enrollment-store.js";
import {
  NativePackagerControlRegistry,
  nativePackagerAuthMessage,
  nativePackagerEnrollmentMessage,
  parseNativePackagerMessage,
} from "../src/native-packager-control.js";

function keyPair() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey: pair.privateKey, publicKey: { ...pair.publicKey.export({ format: "jwk" }), ext: true } };
}

function sign(privateKey, message) {
  return crypto.sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function capability(packagerId, now, rooms = []) {
  return {
    capabilityVersion: 1,
    agentId: packagerId,
    tenantId: "tn_0123456789abcdef",
    ownerSubjectRef: "sub_0123456789abcdef",
    deviceRef: "dev_0123456789abcdef",
    agentVersion: "1.0.0",
    ffmpegVersion: "6.1.1",
    videoEncoders: ["libx264"],
    audioEncoders: ["aac"],
    hardwareClass: "medium",
    cpuClass: "medium",
    gpuClass: "integrated",
    uploadClass: "5-15mbit",
    energyClass: "ac",
    health: "healthy",
    maximumRenditions: 2,
    maximumPixelsPerSecond: 1280 * 720 * 30,
    consentedRoomIds: rooms,
    observedAt: now,
    expiresAt: now + 30_000,
  };
}

test("native packager control enrolls and authenticates a device-bound identity", () => {
  const now = 10_000;
  const ownerPrincipal = "issuer|owner";
  const store = new NativePackagerEnrollmentStore();
  const enrollment = store.createEnrollment({ ownerPrincipal, platform: "linux", now });
  const keys = keyPair();
  const registry = new NativePackagerControlRegistry({ enrollmentStore: store });
  const enrollSocket = {};
  const enrollChallenge = registry.issueChallenge(enrollSocket, now);
  const enrollmentMessage = {
    version: 1, type: "enroll", packagerId: enrollment.packagerId,
    enrollmentToken: enrollment.enrollmentToken, timestamp: now,
    publicKey: keys.publicKey,
  };
  enrollmentMessage.proof = sign(keys.privateKey, nativePackagerEnrollmentMessage(
    enrollment.packagerId, enrollChallenge.nonce, now, enrollment.enrollmentToken, keys.publicKey,
  ));
  registry.enroll(enrollSocket, parseNativePackagerMessage(JSON.stringify(enrollmentMessage)), now);

  const socket = {};
  const challenge = registry.issueChallenge(socket, now + 1);
  const authentication = {
    version: 1, type: "authenticate", packagerId: enrollment.packagerId, timestamp: now + 1,
    proof: sign(keys.privateKey, nativePackagerAuthMessage(enrollment.packagerId, challenge.nonce, now + 1)),
  };
  registry.authenticate(socket, parseNativePackagerMessage(JSON.stringify(authentication)), now + 1);
  assert.equal(registry.connection(socket).ownerPrincipal, ownerPrincipal);
  assert.equal(registry.list(ownerPrincipal, now + 1)[0].online, true);
  assert.equal(registry.allowMessage(socket, now + 2, { limit: 1 }), true);
  assert.equal(registry.allowMessage(socket, now + 3, { limit: 1 }), false);
  store.close();
});

test("server room consent intersects an agent report and cannot be self-asserted", () => {
  const now = 20_000;
  const keys = keyPair();
  const definition = {
    id: "pkr_0123456789abcdef", ownerPrincipal: "issuer|owner", label: "Packager", platform: "linux",
    publicKey: keys.publicKey, keyFingerprint: "A".repeat(43),
  };
  const registry = new NativePackagerControlRegistry({ definitions: [definition] });
  const socket = {};
  const challenge = registry.issueChallenge(socket, now);
  registry.authenticate(socket, {
    version: 1, type: "authenticate", packagerId: definition.id, timestamp: now,
    proof: sign(keys.privateKey, nativePackagerAuthMessage(definition.id, challenge.nonce, now)),
  }, now);
  const refs = { tenantId: "tn_0123456789abcdef", ownerSubjectRef: "sub_0123456789abcdef" };
  const unapproved = registry.setCapability(socket, capability(definition.id, now, ["room-allowed"]), refs, now);
  assert.deepEqual(unapproved.consentedRoomIds, []);
  assert.throws(() => registry.consent("issuer|other", definition.id, "room-allowed", true), /not_found/);
  registry.consent("issuer|owner", definition.id, "room-allowed", true);
  const approved = registry.setCapability(socket, capability(definition.id, now + 1, ["room-allowed", "room-invented"]), refs, now + 1);
  assert.deepEqual(approved.consentedRoomIds, ["room-allowed"]);
  registry.consent("issuer|owner", definition.id, "room-allowed", false);
  assert.deepEqual(registry.list("issuer|owner", now + 1)[0].capability.consentedRoomIds, []);
});

test("native packager protocol fails closed on unknown fields and stale heartbeats", () => {
  assert.throws(() => parseNativePackagerMessage(JSON.stringify({
    version: 1, type: "heartbeat", assignmentId: "", programEpoch: 0,
    state: "idle", observedAt: 1, roomAuthority: true,
  })), /invalid_native_packager_heartbeat/);
  assert.equal(parseNativePackagerMessage(JSON.stringify({
    version: 1, type: "heartbeat", assignmentId: "asn_0123456789abcdef", programEpoch: 2,
    state: "ready", observedAt: 2,
  })).state, "ready");
  assert.throws(() => parseNativePackagerMessage(JSON.stringify({ version: 1, type: "magic" })), /unknown_native_packager_message/);
  assert.equal(parseNativePackagerMessage(JSON.stringify({
    version: 1, type: "assignment-status", assignmentId: "asn_0123456789abcdef",
    programEpoch: 2, fencingRevision: 3, state: "ready", reasonCode: "CAPABILITY_READY",
    observedAt: 2,
  })).state, "ready");
  assert.throws(() => parseNativePackagerMessage(JSON.stringify({
    version: 1, type: "assignment-status", assignmentId: "asn_0123456789abcdef",
    programEpoch: 2, fencingRevision: 3, state: "ready", reasonCode: "CAPABILITY_READY",
    observedAt: 2, decryptAuthority: true,
  })), /invalid_native_packager_assignment_status/);
});
