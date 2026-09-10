import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { NativePackagerResourceBudget, NATIVE_PACKAGER_RESOURCE_DEFAULTS, NATIVE_PACKAGER_RESOURCE_ENV,
  nativePackagerResourceDemand, normalizeNativePackagerResources } from "../src/native-packager-resource-budget.js";

const admission = { admissionVersion: 1, videoEncoder: "libx264", softwareFallback: "libx264",
  renditions: [{ width: 640, height: 360, framesPerSecond: 15, videoBitsPerSecond: 500000, audioBitsPerSecond: 64000 }] };

test("resource planning accounts for actual selected output and full software fallback", () => {
  const expected = { cpuUnits: 4, memoryMiB: 224, encoderSlots: 1, gpuSlots: 0, egressBitsPerSecond: 648600 };
  assert.deepEqual(nativePackagerResourceDemand(admission), expected);
  for (const videoEncoder of ["h264_nvenc", "h264_videotoolbox"]) {
    assert.deepEqual(nativePackagerResourceDemand({ ...admission, videoEncoder }), { ...expected, gpuSlots: 1 });
    assert.equal(new NativePackagerResourceBudget({ cpuUnits: 3 }).allows({ ...admission, videoEncoder }, []), false);
  }
  for (const admissionVersion of [2, 3]) {
    assert.equal(nativePackagerResourceDemand({ ...admission, admissionVersion,
      renditions: [{ ...admission.renditions[0], audioBitsPerSecond: 128000 }] }).egressBitsPerSecond, 722200);
  }
});

test("resource budget is closed, aggregate, exact at its boundary, immutable and fail-closed", () => {
  const demand = nativePackagerResourceDemand(admission);
  const limits = { ...demand }, budget = new NativePackagerResourceBudget(limits);
  limits.encoderSlots = 100;
  assert.equal(budget.allows(admission, []), true);
  assert.equal(budget.allows(admission, [admission]), false);
  assert.equal(budget.allows({ ...admission, videoEncoder: "h264_nvenc" }, []), false);
  for (const bad of [null, [], { extra: 1 }, { cpuUnits: -1 }, { cpuUnits: NaN }, { cpuUnits: Infinity }, { cpuUnits: 1.5 }, { cpuUnits: 1000000001 }]) {
    assert.throws(() => normalizeNativePackagerResources(bad), /invalid_native_packager_resource_budget/);
  }
  for (const bad of [null, {}, { ...admission, admissionVersion: 4 }, { ...admission, videoEncoder: "unknown" },
    { ...admission, renditions: [] }, { ...admission, renditions: [null] },
    { ...admission, renditions: [{ ...admission.renditions[0], width: NaN }] },
    { ...admission, renditions: [{ ...admission.renditions[0], width: 1000000000, height: 1000000000 }] }]) {
    assert.equal(budget.allows(bad, []), false);
    assert.equal(budget.allows(admission, [bad]), false);
  }
  assert.equal(budget.allows(admission, null), false);
  assert.equal(budget.allows(admission, Array(20001).fill(admission)), false);
  assert.ok(Object.isFrozen(normalizeNativePackagerResources()));
});

test("ENV and Compose pass each explicit native resource limit without masking zero or empty values", () => {
  assert.deepEqual(loadConfig({}).broadcastNativeResourceLimits, NATIVE_PACKAGER_RESOURCE_DEFAULTS);
  const compose = parse(fs.readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
  for (const [field, name] of Object.entries(NATIVE_PACKAGER_RESOURCE_ENV)) {
    assert.equal(compose.services.webrtc.environment[name], "${" + name + "-" + NATIVE_PACKAGER_RESOURCE_DEFAULTS[field] + "}");
    for (const value of [0, 1, 1000000000]) assert.equal(loadConfig({ [name]: String(value) }).broadcastNativeResourceLimits[field], value);
    for (const value of ["", "-1", "NaN", "Infinity", "1.5", "1000000001", "10junk"]) {
      assert.throws(() => loadConfig({ [name]: value }), new RegExp(name));
    }
  }
});

test("resource snapshots sum immutable planning vectors without concealing over-budget inventory", () => {
  const budget = new NativePackagerResourceBudget({ encoderSlots: 0 });
  const demand = nativePackagerResourceDemand(admission);
  const result = budget.snapshot([admission, admission]);
  assert.deepEqual(result.used, Object.fromEntries(Object.entries(demand).map(([key, value]) => [key, value * 2])));
  assert.equal(result.limits.encoderSlots, 0);
  for (const value of [result, result.used, result.limits]) assert.ok(Object.isFrozen(value));
  assert.deepEqual(budget.snapshot([]).used, Object.fromEntries(Object.keys(demand).map(key => [key, 0])));
  for (const bad of [null, {}, [null], Array(20001).fill(admission)]) {
    assert.throws(() => budget.snapshot(bad), /invalid_native_packager_resource/);
  }
});
