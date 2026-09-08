import test from "node:test";
import assert from "node:assert/strict";
import { privateMachineTlsProxy } from "./helpers/machine-tls-proxy.js";

function fixture(change = {}) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === "image") return "sha256:" + "a".repeat(64);
    if (args[0] === "inspect") return "true";
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([{
      Internal: true, IPAM: { Config: [{ Gateway: "172.30.0.1", Subnet: "172.30.0.0/16" }] }, ...change,
    }]);
    return "synthetic-docker-result";
  };
  return { calls, run };
}

test("private proxy preserves canonical TLS without host networking or ports", () => {
  const f = fixture(); const proxy = privateMachineTlsProxy(180, f.run);
  assert.equal(proxy.listenHost, "172.30.0.1"); assert.equal(proxy.originHost, "172.30.0.2");
  proxy.start(32123);
  const create = f.calls.find(args => args[0] === "create");
  assert.ok(create.includes("--read-only") && create.includes("--cap-drop=ALL"));
  assert.match(create.at(-1), /server\.maxConnections=16;/);
  assert.ok(!create.some(arg => arg.includes("network=host") || arg === "-p" || arg.startsWith("--publish") || arg.startsWith("--mount")));
  assert.match(create[create.indexOf("--network") + 1], /^meet-test-tls-[a-f0-9-]+-network$/);
  assert.ok(f.calls.some(args => args[0] === "network" && args[1] === "create" && args.includes("--internal")));
  assert.throws(() => proxy.start(32123), /start_invalid/);
  proxy.close(); proxy.close();
  assert.equal(f.calls.filter(args => args[0] === "rm").length, 2);
  assert.equal(f.calls.filter(args => args[0] === "network" && args[1] === "rm").length, 1);
});

test("two packaged Workers use an explicit bounded proxy profile without changing the default", () => {
  const f = fixture(); const proxy = privateMachineTlsProxy(180, f.run, 32);
  try {
    proxy.start(32123);
    const create = f.calls.find(args => args[0] === "create");
    assert.match(create.at(-1), /server\.maxConnections=32;/);
    assert.ok(create.includes("--memory=128m") && create.includes("--cpus=.5"));
    assert.deepEqual(proxy.observation(), { connectionDrops: 0 });
  } finally { proxy.close(); }
});

test("unknown proxy connection profiles fail before Docker side effects", () => {
  const f = fixture();
  for (const limit of [0, 15, 17, 33, 1000, "32", true, null]) {
    assert.throws(() => privateMachineTlsProxy(180, f.run, limit), /connection_limit_invalid/);
  }
  assert.deepEqual(f.calls, []);
});

test("proxy diagnostics retain only eight fixed capacity events", () => {
  const f = fixture();
  const run = args => args[0] === "logs"
    ? "secret-canary\n" + "test_tls_connection_capacity\n".repeat(12) : f.run(args);
  const proxy = privateMachineTlsProxy(180, run);
  assert.deepEqual(proxy.observation(), { connectionDrops: 0 });
  proxy.start(32123);
  assert.deepEqual(proxy.observation(), { connectionDrops: 8 });
  proxy.close();
  assert.deepEqual(proxy.observation(), { connectionDrops: 0 });
});

test("unfamiliar network is rejected and exact owned network is removed", () => {
  const f = fixture({ Internal: false });
  assert.throws(() => privateMachineTlsProxy(180, f.run), /private_proxy_network_invalid/);
  assert.ok(f.calls.some(args => args[0] === "network" && args[1] === "rm"));
  assert.ok(!f.calls.some(args => args[0] === "create"));
});

test("proxy lifetime and target port are bounded", () => {
  const f = fixture();
  for (const lifetime of [0, 179, 7381, "180"]) assert.throws(() => privateMachineTlsProxy(lifetime, f.run), /lifetime_invalid/);
  const proxy = privateMachineTlsProxy(180, f.run);
  try { for (const port of [0, 443, 65536, "32123"]) assert.throws(() => proxy.start(port), /start_invalid/); }
  finally { proxy.close(); }
});

test("explicit TURN proxy composes only its own bounded relay and rejects unknown ICE paths", () => {
  const f = fixture();
  assert.throws(() => privateMachineTlsProxy(180, f.run, 16, "auto"), /ice_path_invalid/);
  assert.equal(f.calls.length, 0);
  const proxy = privateMachineTlsProxy(180, f.run, 16, "turn-tcp");
  try {
    assert.equal(proxy.stunUrl, undefined);
    assert.deepEqual(proxy.turnConfig.turnUrls, ["turn:172.30.0.4:3478?transport=tcp"]);
    proxy.start(32123);
    assert.equal(f.calls.filter(args => args[0] === "create").length, 2);
    assert.ok(f.calls.some(args => args.includes("--use-auth-secret")));
    assert.ok(!f.calls.some(args => args.includes("--stun-only")));
  } finally { proxy.close(); }
  assert.equal(f.calls.filter(args => args[0] === "rm").length, 2);
  assert.equal(f.calls.filter(args => args[0] === "network" && args[1] === "rm").length, 1);
});
