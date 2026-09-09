import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import Ajv from "ajv";
import { createAppServer } from "../src/server.js";
import { machineIntegrationStatus } from "../src/machine-integration-status.js";
import { MACHINE_CAPABILITIES } from "../src/machine-capabilities.js";
import { trustFixture, issuer } from "./helpers/machine-trust.mjs";

const validate = new Ajv({ strict: true }).compile(JSON.parse(await fs.readFile(
  new URL("../contracts/machine/integration.v1.schema.json", import.meta.url), "utf8")));

test("integration projection is bounded, closed and detached from mutable operator input", () => {
  const ceiling = ["chat.send", "chat.read"], snapshot = machineIntegrationStatus(true, ceiling);
  ceiling.push("audio.receive");
  assert.deepEqual(snapshot.operatorCapabilityCeiling, ["chat.read", "chat.send"]);
  assert.deepEqual(snapshot.supportedCapabilities, [...MACHINE_CAPABILITIES].sort());
  assert.ok(validate(snapshot), JSON.stringify(validate.errors));
  assert.ok(Object.isFrozen(snapshot));
  for (const list of [snapshot.operatorCapabilityCeiling, snapshot.supportedCapabilities, snapshot.publisherConsentRequired]) assert.ok(Object.isFrozen(list));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 2048);
  for (const bad of [{ ...snapshot, hubConnected: true }, { ...snapshot, operatorCapabilityCeiling: ["record"] },
    { ...snapshot, publisherConsentRequired: [] }, { ...snapshot, operatorCapabilityCeiling: [] }]) assert.equal(validate(bad), false);
  assert.throws(() => machineIntegrationStatus("true", []));
  assert.throws(() => machineIntegrationStatus(false, ["record"]));
});

for (const mode of ["disabled", "chat-only", "empty-ceiling", "empty-trust"]) {
  test(`real integration GET: ${mode}, no membership, grants or legacy contract change`, { timeout: 5000 }, async t => {
    const f = trustFixture(), ceiling = mode === "empty-ceiling" ? [] : ["chat.read", "chat.send"];
    const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
      machineHubTrustProfile: mode === "disabled" ? null : { ...f.profile, scopes: mode === "empty-trust" ? [] : f.profile.scopes },
      machineAllowedCapabilities: ceiling, oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks",
      stunUrls: [], turnServers: [], mediaE2eeMode: "required" } });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    t.after(() => { app.server.closeAllConnections(); app.server.close(); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base + "/api/machine/integration", { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("set-cookie"), false);
    const body = await response.json(), enabled = mode === "chat-only";
    assert.deepEqual(body, machineIntegrationStatus(enabled, ceiling)); assert.ok(validate(body));
    assert.equal(app.registry.participantCount, 0);
    const serialized = JSON.stringify(body);
    for (const privateValue of [f.profile.issuer, f.profile.keys[0].x, f.profile.scopes[0].projectId]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    const legacy = await (await fetch(base + "/api/machine/capabilities", { signal: AbortSignal.timeout(2000) })).json();
    assert.deepEqual(legacy, { schema: "ananta.meet-capabilities.v1", admissionEnabled: enabled,
      publication: "mp4-v1", sessionLease: "ananta.meet-session-lease.v1", chatEvents: false, audioSubscription: false, screenPublication: false });
  });
}
