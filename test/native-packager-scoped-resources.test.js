import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { NativePackagerScopedResourceBudget } from "../src/native-packager-scoped-resources.js";
import { NATIVE_PACKAGER_RESOURCE_ENV, NATIVE_PACKAGER_RESOURCE_DEFAULTS, nativePackagerResourceDemand } from "../src/native-packager-resource-budget.js";

const admission = { admissionVersion: 1, videoEncoder: "h264_nvenc", softwareFallback: "libx264",
  renditions: [{ width: 640, height: 360, framesPerSecond: 15, videoBitsPerSecond: 500000, audioBitsPerSecond: 64000 }] };
const row = (tenant = "a", owner = "one") => ({ tenantId: `tn_${tenant.repeat(16)}`, ownerPrincipal: `https://synthetic.test|${owner}`, admission });

for (const [field, demand] of Object.entries(nativePackagerResourceDemand(admission))) {
  test(`${field} is bounded across tenants and principals without replacing the global budget`, () => {
    const tenant = new NativePackagerScopedResourceBudget(undefined, { tenant: { [field]: demand } });
    assert.equal(tenant.allows(row(), []), true);
    assert.equal(tenant.allows(row("a", "two"), [row()]), false);
    assert.equal(tenant.allows(row("b"), [row()]), true);
    const principal = new NativePackagerScopedResourceBudget(undefined, { principal: { [field]: demand } });
    assert.equal(principal.allows(row(), [row()]), false);
    assert.equal(principal.allows(row("a", "two"), [row()]), true);
    assert.equal(principal.allows(row("b"), [row()]), true);
    const global = new NativePackagerScopedResourceBudget({ [field]: demand }, { tenant: { [field]: demand * 3 }, principal: { [field]: demand * 3 } });
    assert.equal(global.allows(row("b", "two"), [row()]), false);
    assert.equal(new NativePackagerScopedResourceBudget(undefined, { principal: { [field]: 0 } }).allows(row(), []), false);
  });
}

test("scoped resource policy is closed and keeps global metrics free of identities", () => {
  const input = { tenant: { encoderSlots: 1 } }, budget = new NativePackagerScopedResourceBudget(undefined, input);
  input.tenant.encoderSlots = 100;
  assert.equal(budget.allows(row(), [row()]), false);
  for (const bad of [null, [], { unknown: {} }, { tenant: null }, { principal: { other: 1 } }]) {
    assert.throws(() => new NativePackagerScopedResourceBudget(undefined, bad));
  }
  for (const bad of [null, {}, { ...row(), tenantId: "bad" }, { ...row(), ownerPrincipal: "\n" }, { ...row(), extra: true }]) {
    assert.equal(budget.allows(bad, []), false); assert.equal(budget.allows(row(), [bad]), false);
  }
  assert.doesNotMatch(JSON.stringify(budget.snapshot([row()])), /synthetic|tn_|ownerPrincipal/);
  assert.equal(new NativePackagerScopedResourceBudget({ encoderSlots: 100, gpuSlots: 100 }).allows(row(), Array(50).fill(row())), true);
});

test("all ten scope environment limits inherit globals and preserve explicit zero and invalid values", () => {
  const compose = parse(fs.readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
  for (const scope of ["tenant", "principal"]) for (const [field, base] of Object.entries(NATIVE_PACKAGER_RESOURCE_ENV)) {
    const name = `${base}_PER_${scope.toUpperCase()}`;
    assert.equal(loadConfig({ [base]: "123" }).broadcastNativeScopedResourceLimits[scope][field], 123);
    assert.equal(loadConfig({ [base]: "123", [name]: "0" }).broadcastNativeScopedResourceLimits[scope][field], 0);
    assert.equal(compose.services.webrtc.environment[name], "${" + name + "-${" + base + "-" + NATIVE_PACKAGER_RESOURCE_DEFAULTS[field] + "}}");
    for (const invalid of ["", " ", "no", "-1", "1.5", "1000000001", null, true]) {
      assert.throws(() => loadConfig({ [name]: invalid }), new RegExp(name));
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BROADCAST_NATIVE_")));
  const rendered = JSON.parse(execFileSync("docker", ["compose", "--env-file", "/dev/null", "-f", "compose.yaml", "config", "--format", "json"],
    { cwd: new URL("..", import.meta.url), env: { ...env, BROADCAST_NATIVE_ENCODER_SLOTS: "123", BROADCAST_NATIVE_ENCODER_SLOTS_PER_PRINCIPAL: "0" },
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(rendered.services.webrtc.environment.BROADCAST_NATIVE_ENCODER_SLOTS_PER_TENANT, "123");
  assert.equal(rendered.services.webrtc.environment.BROADCAST_NATIVE_ENCODER_SLOTS_PER_PRINCIPAL, "0");
});
