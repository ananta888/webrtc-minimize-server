import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { machineIntegrationStatus } from "../src/machine-integration-status.js";
import { MACHINE_CAPABILITIES } from "../src/machine-capabilities.js";
import { parseMachineChatEvent } from "../src/machine-chat-contract.js";
import { parseMachineRolloutPlan } from "../src/machine-rollout-plan.js";

const ROOT = new URL("../contracts/machine/", import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, ROOT), "utf8"));
const fixtures = await readJson("fixtures/contract-fixtures.v1.json");

test("machine schemas are closed, compile, and reject unknown fields", async () => {
  const files = (await readdir(ROOT, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map(entry => entry.name).sort();
  const expected = [
    "authorization.v1.schema.json", "chat-event.draft1.schema.json", "client-probe.v1.schema.json",
    "integration.v1.schema.json", "machine-binding.v1.schema.json", "machine-context.v1.schema.json",
    "rollout-plan.v1.schema.json", "rollout-plan.v2.schema.json", "session-lease.v1.schema.json",
    "session-observation.v1.schema.json", "session-retired.v1.schema.json", "visual-probe.v1.schema.json",
  ];
  assert.deepEqual(files, expected);
  const ajv = new Ajv({ strict: true, allErrors: true });
  const schemas = await Promise.all(files.map(file => readJson(file)));
  for (const schema of schemas) {
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.type, "object");
    ajv.addSchema(schema);
  }
  assert.equal(fixtures.version, 1);
  assert.equal(fixtures.cases.length, expected.length - 1, "binding is nested, not a standalone fixture family");
  for (const fixture of fixtures.cases) {
    const validate = ajv.getSchema(JSON.parse(await readFile(new URL(fixture.schema, ROOT), "utf8")).$id);
    assert.equal(validate(fixture.minimal), true, `${fixture.type} minimal ${JSON.stringify(validate.errors)}`);
    assert.equal(validate(fixture.full), true, `${fixture.type} full ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...fixture.minimal, ...fixture.invalidPatch }), false, fixture.invalidReason);
  }
});

test("live integration, chat and rollout objects match the closed fixtures", () => {
  const ajv = new Ajv({ strict: true });
  const cases = new Map(fixtures.cases.map(entry => [entry.type, entry]));
  return Promise.all([
    readJson("integration.v1.schema.json"),
    readJson("chat-event.draft1.schema.json"),
    readJson("rollout-plan.v1.schema.json"),
    readJson("rollout-plan.v2.schema.json"),
  ]).then(([integration, chat, v1, v2]) => {
    const check = (schema, value) => {
      const validate = ajv.compile(schema);
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
    };
    check(integration, machineIntegrationStatus(false, []));
    check(integration, machineIntegrationStatus(true, ["chat.read", "chat.send"]));
    assert.deepEqual(machineIntegrationStatus(true, ["chat.send", "chat.read"]).supportedCapabilities,
      [...MACHINE_CAPABILITIES].sort());
    const event = parseMachineChatEvent(JSON.stringify(cases.get("chat-event").full));
    check(chat, event);
    check(v1, parseMachineRolloutPlan(cases.get("rollout-plan").full));
    check(v2, parseMachineRolloutPlan(cases.get("rollout-plan-v2").full));
  });
});
