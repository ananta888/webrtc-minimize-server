import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const fixture = JSON.parse(await readFile(new URL("../native-broadcast-packager/testdata/source-program-assignment.v4.json", import.meta.url), "utf8"));
const schema = JSON.parse(await readFile(new URL("../contracts/native-packager/assignment-prepare.v4.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

test("v4 program assignment has an explicit server scope, not a legacy publisher", () => {
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  assert.equal("publisherPeerId" in fixture, false);
  assert.equal(fixture.inputMode, "trusted-sframe-v1");
  assert.equal(validate({ ...fixture, iceServers: [] }), true, "direct ICE requires no infrastructure server");
  assert.equal(validate({ ...fixture, iceServers: null }), false);
  assert.equal(validate({ ...fixture, publisherPeerId: "0123456789abcdef" }), false);
  for (const encoder of ["libx264", "h264_nvenc", "h264_videotoolbox"]) {
    const value = structuredClone(fixture); value.profile.videoEncoder = encoder;
    assert.equal(validate(value), true); // Shape only; not hardware permission/readiness.
  }
});

test("v4 rejects missing or extra fields at every contract object level", () => {
  for (const path of [[], ["sourceContext"], ["profile"], ["profile", "renditions", 0], ["iceServers", 0], ["iceServers", 1]]) {
    const target = value => path.reduce((node, key) => node[key], value);
    for (const key of Object.keys(target(fixture))) {
      const value = structuredClone(fixture); delete target(value)[key];
      assert.equal(validate(value), false, "missing " + [...path, key].join("/"));
    }
    const value = structuredClone(fixture); target(value).decryptKey = "forbidden";
    assert.equal(validate(value), false, "extra field at " + path.join("/"));
    for (const key of Object.keys(target(fixture))) {
      const alias = structuredClone(fixture), object = target(alias);
      object[key.toUpperCase()] = object[key]; delete object[key];
      assert.equal(validate(alias), false, "case alias at " + [...path, key].join("/"));
    }
  }
});

test("v4 URI and identifier patterns reject trailing line terminators and non-ASCII URI codepoints", () => {
  for (const suffix of ["\0", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u2003", "\ufeff", "\u2028", "\u2029", "😀"]) {
    for (const index of [0, 1]) {
      const value = structuredClone(fixture); value.iceServers[index].urls[0] += suffix;
      assert.equal(validate(value), false, "invalid URI codepoint " + suffix.codePointAt(0));
    }
  }
  for (const field of ["assignmentId", "roomId", "programId", "leaseId", "resourceRef"]) {
    const value = structuredClone(fixture); value[field] += "\n";
    assert.equal(validate(value), false, "trailing newline " + field);
  }
  for (const field of ["tenantId", "granteeDeviceRef"]) {
    const value = structuredClone(fixture); value.sourceContext[field] += "\n";
    assert.equal(validate(value), false, "trailing context newline " + field);
  }
});

test("v4 bounds epochs, clocks, rendition identities/dimensions and ICE credential scope", () => {
  const invalid = [
    v => { v.version = 3; }, v => { v.inputMode = "legacy"; },
    v => { v.sourceContext.tenantId = "unbound"; }, v => { v.sourceContext.roomEpoch = 2 ** 53; },
    v => { v.sourceContext.frameEnvelope = "unknown"; }, v => { v.programEpoch = 0; },
    v => { v.fencingRevision = 2 ** 53; }, v => { v.expiresAt = 2 ** 53; },
    v => { v.profile.renditions[0].width = 321; }, v => { v.profile.renditions[0].height = 181; },
    v => { v.profile.renditions.push({ ...v.profile.renditions[0], width: 640 }); },
    v => { v.profile.renditions[0].framesPerSecond = 61; },
    v => { v.iceServers[0].username = ""; },
    v => { v.iceServers[1].urls.push("stun:stun.example.test:3478"); },
    v => { v.iceServers[1].credentialType = "oauth"; },
  ];
  for (const change of invalid) {
    const value = structuredClone(fixture); change(value); assert.equal(validate(value), false);
  }
});

test("legacy v1/v2/v3 schemas remain closed to v4 scope and mode", async () => {
  for (const filename of ["server-control.v1.schema.json", "assignment-prepare.v2.schema.json", "assignment-prepare.v3.schema.json"]) {
    const legacy = JSON.parse(await readFile(new URL("../contracts/native-packager/" + filename, import.meta.url), "utf8"));
    assert.equal(new Ajv2020({ strict: true }).compile(legacy)(fixture), false);
  }
});
