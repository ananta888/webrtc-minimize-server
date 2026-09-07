import test from "node:test";
import assert from "node:assert/strict";
import { privateMachineStun } from "./helpers/machine-stun-fixture.js";

const scope = { network: "meet-test-tls-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa-network", address: "172.30.0.4", lifetimeSeconds: 180 };

test("test STUN runs bounded discovery only, with no TURN allocation or host ports", () => {
  const calls = [];
  const run = args => { calls.push(args); return args[0] === "image" ? "sha256:" + "a".repeat(64) : args[0] === "inspect" ? "true" : ""; };
  const fixture = privateMachineStun(scope, run);
  assert.equal(fixture.url, "stun:172.30.0.4:3478"); fixture.start();
  const create = calls.find(args => args[0] === "create");
  for (const flag of ["--stun-only", "--no-auth", "--no-cli", "--no-tcp", "--no-tls", "--no-dtls", "--no-stdout-log",
    "--user=65534:65534", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--entrypoint=/usr/bin/timeout"])
    assert.ok(create.includes(flag));
  assert.ok(create.includes("180") && create.includes("--kill-after=5"));
  assert.ok(!create.some(arg => ["-p", "-v", "--privileged"].includes(arg) || arg.startsWith("--publish") || arg.startsWith("--mount")));
  assert.throws(() => fixture.start(), /start_invalid/);
  fixture.close(); fixture.close();
  const removed = calls.filter(args => args[0] === "rm");
  assert.equal(removed.length, 1); assert.match(removed[0][2], /^meet-test-stun-/);
  assert.ok(!calls.some(args => args[0] === "network" && args[1] === "rm"));
});

test("test STUN rejects broad networks, public IPs and invalid lifetimes before Docker", () => {
  for (const change of [{ network: "host" }, { address: "8.8.8.8" }, { address: "::1" }, { lifetimeSeconds: 0 }, { lifetimeSeconds: "180" }]) {
    assert.throws(() => privateMachineStun({ ...scope, ...change }, () => assert.fail("no Docker before scope validation")), /scope_invalid/);
  }
});

test("test STUN retains exact cleanup after failed or uncertain creation", () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === "image") return "sha256:" + "a".repeat(64);
    if (args[0] === "create") throw new Error("synthetic_create_timeout");
    return "";
  };
  const fixture = privateMachineStun(scope, run);
  assert.throws(() => fixture.start(), /synthetic_create_timeout/);
  fixture.close(); assert.equal(calls.at(-1)[0], "rm");
});
