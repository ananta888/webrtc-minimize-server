import test from "node:test";
import assert from "node:assert/strict";
import { privateMachineTurn } from "./helpers/machine-turn-fixture.js";
import { assertMachineRelayObservation, waitMachineRelaySetup } from "./helpers/machine-relay-observation.js";

const scope = { network: "meet-test-tls-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa-network",
  address: "172.30.0.4", lifetimeSeconds: 180, transport: "udp" };
function runner() {
  const calls = [];
  return { calls, run(args) { calls.push(args); return args[0] === "image" ? "sha256:" + "a".repeat(64)
    : args[0] === "inspect" ? "true" : ""; } };
}
for (const transport of ["udp", "tcp"]) test(`test TURN ${transport} requires auth and bounds ports, peers, resources and cleanup`, () => {
  const f = runner(), relay = privateMachineTurn({ ...scope, transport }, f.run);
  assert.deepEqual(relay.config.turnUrls, [`turn:172.30.0.4:3478?transport=${transport}`]);
  assert.match(relay.config.turnSharedSecret, /^[a-f0-9]{64}$/);
  relay.start();
  const create = f.calls.find(args => args[0] === "create");
  for (const flag of ["--use-auth-secret", "--no-cli", "--no-tls", "--no-dtls", "--no-tcp-relay", "--no-stdout-log",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--total-quota=16", "--user-quota=8",
    "--min-port=49160", "--max-port=49191", "--bps-capacity=4000000", "--max-bps=1000000",
    "--allowed-peer-ip=172.30.0.4", "--denied-peer-ip=0.0.0.0-255.255.255.255",
    "--entrypoint=/usr/bin/timeout", "180", "--kill-after=5", transport === "udp" ? "--no-tcp" : "--no-udp"])
    assert.ok(create.includes(flag), flag);
  assert.ok(!create.includes("--no-auth") && !create.includes("--stun-only"));
  assert.ok(!create.some(arg => ["-p", "-v", "--privileged"].includes(arg) || /^--(publish|mount)/.test(arg)));
  assert.throws(() => relay.start(), /start_invalid/); relay.close(); relay.close();
  assert.equal(f.calls.filter(args => args[0] === "rm").length, 1);
  assert.match(f.calls.at(-1)[2], /^meet-test-turn-/);
});
test("test TURN refuses broad scopes and malformed inputs before side effects", () => {
  for (const patch of [{ network: "host" }, { address: "8.8.8.8" }, { address: "::1" }, { transport: "tls" },
    { lifetimeSeconds: 179 }, { lifetimeSeconds: 7381 }, { lifetimeSeconds: "180" }])
    assert.throws(() => privateMachineTurn({ ...scope, ...patch }, () => assert.fail("no Docker")), /scope_invalid/);
});
test("test TURN removes only its own uncertain creation and uses a fresh REST secret", () => {
  const f = runner(), first = privateMachineTurn(scope, f.run), second = privateMachineTurn(scope, f.run);
  assert.notEqual(first.config.turnSharedSecret, second.config.turnSharedSecret);
  first.close(); second.close(); assert.equal(f.calls.filter(args => args[0] === "rm").length, 0);
  const broken = privateMachineTurn(scope, args => {
    if (args[0] === "create") throw new Error("fixture_timeout"); return f.run(args);
  });
  assert.throws(() => broken.start(), /fixture_timeout/); broken.close();
  assert.equal(f.calls.filter(args => args[0] === "rm").length, 1);
});
test("relay evidence refuses host candidates, gathering-only, stale counters and policy downgrade", () => {
  const good = { connections: 1, pairs: 1, relayPairs: 1, policyFailures: 0, sent: 100, received: 100, udp: 1, tcp: 0 };
  assertMachineRelayObservation(good, "udp");
  for (const patch of [{ connections: 0 }, { pairs: 0 }, { pairs: 2 }, { relayPairs: 0 }, { policyFailures: 1 }, { tcp: 1 }, { received: 0 }])
    assert.throws(() => assertMachineRelayObservation({ ...good, ...patch }, "udp"));
  assert.throws(() => assertMachineRelayObservation(good, "udp", good));
});
test("relay observation waits for a consistent selected pair without repeating any room operation", async () => {
  const good = { connections: 1, sctpConnections: 1, pairs: 1, relayPairs: 1, policyFailures: 0 };
  let calls = 0;
  const pages = [{ evaluate: async () => ++calls === 1 ? { ...good, pairs: 0 } : good }];
  assert.deepEqual(await waitMachineRelaySetup(pages, 1500), [good]);
  assert.equal(calls, 2);
  await assert.rejects(waitMachineRelaySetup(pages, 999999), /budget_invalid/);
});
