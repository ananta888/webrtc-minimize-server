import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { parseNativePackagerMessage } from "../src/native-packager-control.js";
import { normalizeNativePackagerCapability, supportsNativeSourceSignalV1 } from "../src/native-packager-policy.js";

const now = 1_800_000_000_000;
const legacy = { capabilityVersion: 1, agentId: "pkr_aaaaaaaaaaaaaaaa", tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa", agentVersion: "0.8.0", ffmpegVersion: "6.1",
  videoEncoders: ["libx264"], audioEncoders: ["aac"], hardwareClass: "medium", cpuClass: "medium", gpuClass: "none",
  uploadClass: "5-15mbit", energyClass: "ac", health: "healthy", maximumRenditions: 2,
  maximumPixelsPerSecond: 1280 * 720 * 30, consentedRoomIds: ["room-alpha"], observedAt: now, expiresAt: now + 30000 };
const enabled = { ...legacy, capabilityVersion: 2, sourcePrograms: true };

test("shared Go report uses the unchanged envelope and an independently closed v2 schema", () => {
  const message = JSON.parse(fs.readFileSync(new URL("./fixtures/native-source-capability.v2.json", import.meta.url)));
  const schema = JSON.parse(fs.readFileSync(new URL("../contracts/native-packager/capability.v2.schema.json", import.meta.url)));
  const validate = new Ajv({ strict: true }).compile(schema);
  assert.equal(validate(message.capability), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseNativePackagerMessage(JSON.stringify(message)), message);
  assert.equal(supportsNativeSourceSignalV1(normalizeNativePackagerCapability(message.capability, now)), true);
  for (const field of Object.keys(message.capability)) {
    const missing = { ...message.capability }; delete missing[field];
    assert.equal(validate(missing), false, field);
  }
  for (const patch of [{ sourcePrograms: "true" }, { authority: true }, { capabilityVersion: 1 }, { capabilityVersion: 3 }]) {
    assert.equal(validate({ ...message.capability, ...patch }), false);
  }
  for (const patch of [{ agentId: "mini-packager" }, { videoEncoders: [] }, { audioEncoders: [] },
    { videoEncoders: ["libx264", "libx264"] }, { audioEncoders: ["aac", "aac"] },
    { videoEncoders: ["h264_vaapi"] }, { observedAt: 0 }, { expiresAt: 0 }]) {
    const value = { ...message.capability, ...patch };
    assert.equal(validate(value), false);
    assert.throws(() => normalizeNativePackagerCapability(value, now), /invalid_native_packager_capability/);
  }
  const v1 = JSON.parse(fs.readFileSync(new URL("../contracts/native-packager/client-control.v1.schema.json", import.meta.url)));
  assert.equal(new Ajv({ strict: true }).compile(v1)(message), false, "old receivers remain closed to the new report");
});

test("source signaling requires explicit source-program opt-in, never a build version", () => {
  assert.equal(supportsNativeSourceSignalV1(normalizeNativePackagerCapability(enabled, now)), true);
  for (const value of ["9.0.0", undefined, null, legacy, { ...legacy, agentVersion: "9.0.0" },
    { ...enabled, sourcePrograms: false }, { ...enabled, sourcePrograms: "true" }, { ...enabled, capabilityVersion: 3 }]) {
    assert.equal(supportsNativeSourceSignalV1(value), false);
  }
});

test("v2 capability is additive and closed, with no default opt-in or mutable room list", () => {
  assert.equal(normalizeNativePackagerCapability(legacy, now).capabilityVersion, 1);
  const normalized = normalizeNativePackagerCapability(enabled, now);
  assert.equal(Object.isFrozen(normalized), true); assert.equal(Object.isFrozen(normalized.consentedRoomIds), true);
  assert.notEqual(normalized.consentedRoomIds, enabled.consentedRoomIds);
  assert.equal(normalizeNativePackagerCapability({ ...enabled, sourcePrograms: false }, now).sourcePrograms, false);
  for (const patch of [{ capabilityVersion: 1 }, { capabilityVersion: 3 }, { sourcePrograms: undefined },
    { sourcePrograms: null }, { sourcePrograms: 1 }, { sourcePrograms: "enabled" }, { programAuthority: true }]) {
    assert.throws(() => normalizeNativePackagerCapability({ ...enabled, ...patch }, now), /invalid_native_packager_capability/);
  }
  const missing = { ...enabled }; delete missing.sourcePrograms;
  assert.throws(() => normalizeNativePackagerCapability(missing, now), /invalid_native_packager_capability/);
});
