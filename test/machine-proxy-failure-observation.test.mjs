import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { observeMachineProxyFailure } from "./helpers/machine-proxy-failure-observation.mjs";

const name = "meet-test-tls-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const state = { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 };

test("proxy failure snapshot executes only four bounded read-only operations for its exact fixture", () => {
  const calls = [], secret = "private-command-token-and-address";
  const value = observeMachineProxyFailure(name, (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === "exec") return "";
    return args[0] === "inspect" ? JSON.stringify({ ...state, Error: secret, Pid: 123, StartedAt: secret })
      : secret + "\ntest_tls_process_entered\ntest_tls_network_module_loaded\ntest_tls_listener_ready\ntest_tls_connection_capacity\n";
  });
  assert.deepEqual(value, { container: { status: "running", running: true, oomKilled: false, exitCode: 0 },
    processEntered: true, networkModuleLoaded: true, listenerAnnounced: true, resources: { process: null, cpu: null, memory: null, io: null }, waitSymbol: null });
  assert.deepEqual(calls.map(c => [c.file, ...c.args]), [
    ["docker", "inspect", "--format", "{{json .State}}", name], ["docker", "logs", "--tail", "16", name],
    ["docker", "exec", name, "cat", "/proc/1/stat", "/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/memory.events", "/proc/1/io"],
    ["docker", "exec", name, "cat", "/proc/1/wchan"],
  ]);
  for (const { options } of calls) assert.deepEqual(options, { encoding: "utf8", timeout: 1000,
    killSignal: "SIGKILL", maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.container));
  assert.equal(JSON.stringify(value).includes(secret), false);
});

test("proxy failure snapshot rejects unknown scopes before any process", () => {
  for (const value of [undefined, null, 1, "", "production", "--all", name + "\n", name + "/other", name.toUpperCase()]) {
    assert.equal(observeMachineProxyFailure(value, () => assert.fail("unexpected process")), null);
  }
});

test("entry markers are exact historical lines and do not turn unknown or partial logs into readiness", () => {
  for (const [logs, expected] of [
    ["test_tls_process_entered\n", [true, false, false]],
    ["test_tls_process_entered\ntest_tls_network_module_loaded\n", [true, true, false]],
    ["prefix test_tls_process_entered\ntest_tls_network_module_loaded suffix\n", [false, false, false]],
    ["test_tls_process_entered\n" + "x".repeat(4096), [null, null, null]],
  ]) {
    const result = observeMachineProxyFailure(name, (_file, args) => args[0] === "inspect" ? JSON.stringify(state) : logs);
    assert.deepEqual([result.processEntered, result.networkModuleLoaded, result.listenerAnnounced], expected);
  }
});

test("failed, malformed, oversized and non-string reads remain unknown, never healthy", () => {
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ ...state, Status: "secret" }),
    JSON.stringify({ ...state, ExitCode: 256 }), JSON.stringify({ ...state, Running: "true" }),
    JSON.stringify({ ...state, OOMKilled: null }), "x".repeat(4097), "ü".repeat(2049), Buffer.from("test_tls_listener_ready")]) {
    const value = observeMachineProxyFailure(name, () => body);
    assert.equal(value.container, null); assert.notEqual(value.listenerAnnounced, true);
    assert.ok(!JSON.stringify(value).includes("secret"));
  }
  assert.deepEqual(observeMachineProxyFailure(name, () => { throw Error("private docker command"); }),
    { container: null, processEntered: null, networkModuleLoaded: null, listenerAnnounced: null, resources: null, waitSymbol: null });
});

test("a listener announcement is historical, not proof of current process health", () => {
  const value = observeMachineProxyFailure(name, (_file, args) => args[0] === "inspect"
    ? JSON.stringify({ ...state, Status: "exited", Running: false, OOMKilled: true, ExitCode: 137 }) : "test_tls_listener_ready\n");
  assert.deepEqual(value, { container: { status: "exited", running: false, oomKilled: true, exitCode: 137 },
    processEntered: false, networkModuleLoaded: false, listenerAnnounced: true, resources: { process: null, cpu: null, memory: null, io: null }, waitSymbol: null });
  assert.equal(observeMachineProxyFailure(name, () => "prefix test_tls_listener_ready\ntest_tls_listener_ready suffix\n").listenerAnnounced, false);
});

test("an actual stuck inspection is killed without retaining its partial output or changing the original failure", { timeout: 4000 }, () => {
  let calls = 0;
  const started = performance.now();
  const value = observeMachineProxyFailure(name, (_file, _args, options) => {
    if (++calls > 1) return "";
    return execFileSync(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('private-canary');setInterval(()=>{},1000)"], options);
  });
  assert.equal(calls, 4); assert.deepEqual(value, { container: null, processEntered: false, networkModuleLoaded: false, listenerAnnounced: false,
    resources: { process: null, cpu: null, memory: null, io: null }, waitSymbol: null });
  assert.ok(performance.now() - started < 3000);
});
