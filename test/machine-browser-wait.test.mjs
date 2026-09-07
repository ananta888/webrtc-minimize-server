import assert from "node:assert/strict";
import test from "node:test";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

test("fixture wait accepts an observed boolean, not arbitrary truthy objects", async () => {
  let calls = 0; const page = { evaluate: async () => ++calls < 3 ? {} : true };
  assert.equal(await waitFixtureValue(page, () => true), true); assert.equal(calls, 3);
});
test("fixture wait returns the exact accepted pixel snapshot", async () => {
  const value = { white: 150, center: [120, 220, 210] };
  const page = { evaluate: async () => value };
  assert.equal(await waitFixtureValue(page, () => null, null, { accept: v => v?.white > 100 }), value);
});
test("a serialized unresolved Angular promise can never satisfy a wait", async () => {
  const page = { evaluate: async () => ({ __zone_symbol__state: null, __zone_symbol__value: [] }) };
  await assert.rejects(waitFixtureValue(page, () => true, null, { accept: () => true }), /non_value/);
});
test("hung reads terminate within the host deadline and late completion never repolls", async () => {
  let calls = 0, finish; const page = { evaluate: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  await assert.rejects(waitFixtureValue(page, () => true, null, { timeout: 20 }), /deadline/);
  finish(false); await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(calls, 1);
});
test("cancel stops a pending navigation predicate without orphan polling", async () => {
  const controller = new AbortController(); let calls = 0;
  const page = { evaluate: async () => { calls++; return false; } };
  const pending = waitFixtureValue(page, () => false, null, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /cancelled/); await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(calls, 1);
});
test("predicate errors and invalid deadlines are not retried", async () => {
  const error = new Error("policy_denied"); let calls = 0;
  const page = { evaluate: async () => { calls++; throw error; } };
  await assert.rejects(waitFixtureValue(page, () => true), e => e === error); assert.equal(calls, 1);
  for (const timeout of [0, -1, 30001, NaN]) await assert.rejects(waitFixtureValue(page, () => true, null, { timeout }), /budget/);
});
