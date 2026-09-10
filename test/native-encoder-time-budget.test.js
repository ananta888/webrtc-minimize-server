import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { NativeEncoderTimeBudget, normalizeNativeEncoderMinutes, nativeEncoderMinutesFromEnvironment,
  NATIVE_ENCODER_MINUTES_ENV, NATIVE_ENCODER_WINDOW_MS as HOUR } from "../src/native-encoder-time-budget.js";

const NOW = 1800000000000;
const scope = (tenant = "a", owner = "owner") => ({ tenantId: `tn_${tenant.repeat(16)}`, ownerPrincipal: `https://id.example|${owner}` });
const call = (budget, method, s = scope(), slots = 1, from = NOW, until = NOW + 60000, now = NOW) => budget[method](s, slots, from, until, now);

for (const dimension of ["deployment", "tenant", "principal"]) test(`authorized encoder time enforces ${dimension} and only that scope`, () => {
  const budget = new NativeEncoderTimeBudget({ deployment: 10, tenant: 10, principal: 10, [dimension]: 1 });
  for (let i = 0; i < 30; i++) assert.equal(call(budget, "allows"), true);
  assert.equal(budget.snapshot(NOW).authorizedEncoderMilliseconds, 0);
  assert.equal(call(budget, "reserve"), true);
  assert.equal(call(budget, "reserve", scope(), 1, NOW, NOW + 1), false);
  assert.equal(budget.snapshot(NOW).authorizedEncoderMilliseconds, 60000, "denial is atomic, not a partial charge");
  assert.equal(call(budget, "reserve", scope("a", "other")), dimension === "principal");
  assert.equal(call(budget, "reserve", scope("b")), dimension !== "deployment");
});

test("fixed UTC boundary charges both hours in exact encoder milliseconds", () => {
  const budget = new NativeEncoderTimeBudget({ deployment: 1 });
  const now = NOW + HOUR - 10000;
  assert.equal(call(budget, "reserve", scope(), 3, now, now + 20000, now), true);
  assert.equal(budget.snapshot(now).authorizedEncoderMilliseconds, 30000);
  assert.equal(call(budget, "reserve", scope(), 3, now, now + 10000, now), true);
  assert.equal(call(budget, "reserve", scope(), 1, now, now + 1, now), false);
  assert.equal(budget.snapshot(NOW + HOUR).authorizedEncoderMilliseconds, 30000);
  assert.equal(call(budget, "reserve", scope(), 1, NOW + HOUR, NOW + HOUR + 30000, NOW + HOUR), true);
  assert.equal(budget.snapshot(NOW + HOUR).authorizedEncoderMilliseconds, 60000);
  assert.equal(budget.snapshot(NOW + 2 * HOUR).authorizedEncoderMilliseconds, 0);
});

test("bounded pseudonymous scopes fail closed until the old window expires", () => {
  const budget = new NativeEncoderTimeBudget({}, 6);
  assert.equal(call(budget, "reserve", scope("a")), true);
  assert.equal(call(budget, "reserve", scope("b")), true);
  assert.equal(call(budget, "reserve", scope("c")), false);
  const snapshot = budget.snapshot(NOW);
  assert.equal(snapshot.authorizedEncoderMilliseconds, 120000);
  assert.doesNotMatch(JSON.stringify(snapshot), /owner|tn_|id.example/);
  assert.equal(call(budget, "reserve", scope("c"), 1, NOW + HOUR, NOW + HOUR + 1000, NOW + HOUR), true);
});

test("clock rollback and invalid time permanently fence the current process budget", () => {
  for (const time of [NOW - 1, NaN, Infinity, 0, Number.MAX_SAFE_INTEGER]) {
    const budget = new NativeEncoderTimeBudget(); assert.equal(call(budget, "reserve"), true);
    assert.equal(call(budget, "reserve", scope(), 1, time, time + 1000, time), false);
    assert.equal(call(budget, "reserve", scope(), 1, NOW + HOUR, NOW + HOUR + 1000, NOW + HOUR), false);
    assert.deepEqual(budget.snapshot(NOW + HOUR), { blocked: true, windowStart: null,
      authorizedEncoderMilliseconds: null, limitEncoderMilliseconds: 2880 * 60000 });
  }
});

test("only closed owned scope, bounded slots and at most 120 future seconds may be reserved", () => {
  const budget = new NativeEncoderTimeBudget({ deployment: 0 });
  assert.equal(call(budget, "reserve"), false);
  assert.equal(call(budget, "reserve", scope(), 1, NOW, NOW), true, "no extension consumes no new time");
  for (const bad of [null, {}, [], { ...scope(), programId: "prg_aaaaaaaaaaaaaaaa" }, { ...scope(), ownerPrincipal: "unsafe\n" }]) {
    assert.equal(call(budget, "reserve", bad), false);
  }
  for (const slots of [0, 4, NaN, 1.5]) assert.equal(call(budget, "reserve", scope(), slots), false);
  for (const until of [NOW - 1, NOW + 120001, Infinity]) assert.equal(call(budget, "reserve", scope(), 1, NOW, until), false);
});

test("ENV, configuration and Compose inherit limits and preserve zero without accepting invalid input", () => {
  assert.deepEqual(normalizeNativeEncoderMinutes(), { deployment: 2880, tenant: 2880, principal: 2880 });
  const compose = parse(readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
  const base = NATIVE_ENCODER_MINUTES_ENV.deployment;
  for (const [field, name] of Object.entries(NATIVE_ENCODER_MINUTES_ENV)) {
    for (const value of [0, 1, 1000000000]) assert.equal(loadConfig({ [name]: String(value) }).broadcastNativeEncoderMinutes[field], value);
    assert.equal(compose.services.webrtc.environment[name], field === "deployment" ? `\${${name}-2880}` : `\${${name}-\${${base}-2880}}`);
    for (const bad of ["", " ", "NaN", "Infinity", "-1", "1.5", "1000000001", true, null, {}, []]) {
      assert.throws(() => nativeEncoderMinutesFromEnvironment({ [name]: bad }), new RegExp(name));
    }
  }
  assert.deepEqual(loadConfig({ [base]: "7" }).broadcastNativeEncoderMinutes, { deployment: 7, tenant: 7, principal: 7 });
  for (const bad of [null, [], { extra: 1 }, { deployment: null }, { tenant: NaN }, { principal: -1 }]) assert.throws(() => normalizeNativeEncoderMinutes(bad));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BROADCAST_NATIVE_ENCODER_MINUTES")));
  const rendered = JSON.parse(execFileSync("docker", ["compose", "--env-file", "/dev/null", "-f", "compose.yaml", "config", "--format", "json"],
    { cwd: new URL("..", import.meta.url), env: { ...env, [base]: "17", [NATIVE_ENCODER_MINUTES_ENV.principal]: "0" },
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(rendered.services.webrtc.environment[NATIVE_ENCODER_MINUTES_ENV.tenant], "17");
  assert.equal(rendered.services.webrtc.environment[NATIVE_ENCODER_MINUTES_ENV.principal], "0");
});
