import test from "node:test";
import assert from "node:assert/strict";
import { machineDockerCommand, machineDockerFailure } from "./helpers/machine-docker-command.js";

test("fixture Docker runner preserves bounded execution and trimmed successful output", () => {
  const args = ["image", "inspect", "synthetic"];
  assert.equal(machineDockerCommand(args, (binary, received, options) => {
    assert.equal(binary, "docker"); assert.equal(received, args);
    assert.deepEqual(options, { encoding: "utf8", timeout: 30000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
    return "  synthetic-result\n";
  }), "synthetic-result");
});

test("Docker failures expose only fixed operation, bounded status and classified reason", () => {
  const cases = [
    ["No such image", "image_unavailable"], ["no matching manifest", "image_platform"],
    ["user specified IP address is supported only when connecting to networks with user configured subnets", "network_subnet"],
    ["Address already in use", "network_address"], ["NanoCPUs unsupported", "cpu_limit"],
    ["all predefined address pools have been fully subnetted", "network_pool_exhausted"],
    ["network synthetic has active endpoints", "network_busy"],
    ["network synthetic has active containers", "network_busy"],
    ["operation not permitted", "permission"], ["container name is already in use", "container_conflict"],
    ["novel error", "unknown"],
  ];
  for (const [stderr, reason] of cases) {
    const secret = "secret-canary-do-not-expose";
    const original = Object.assign(new Error(secret), { stderr: stderr + " " + secret, status: 125 });
    assert.throws(() => machineDockerCommand(["create", secret], () => { throw original; }), error => {
      assert.equal(error.message, `test_docker_command_failed:create:125:${reason}`);
      assert.equal(error.cause, undefined); assert.equal(error.stderr, undefined);
      assert.equal(error.stack.includes(secret), false); return true;
    });
  }
});

test("both bridge diagnostics preserve only the exact closed Docker projection", () => {
  const operations = ["create", "start", "inspect", "image", "network", "rm", "logs", "unknown"];
  const reasons = ["image_unavailable", "image_platform", "network_subnet", "network_address",
    "network_pool_exhausted", "network_busy", "cpu_limit", "permission", "container_conflict", "deadline", "unknown"];
  for (const operation of operations) for (const status of ["0", "1", "125", "255", "unknown"]) for (const reason of reasons) {
    const message = `test_docker_command_failed:${operation}:${status}:${reason}`;
    const error = Object.assign(new Error(message), { stderr: "secret-canary", cause: new Error("secret-canary") });
    assert.equal(machineDockerFailure(error), message);
  }
});

test("bridge projection rejects arbitrary text, noncanonical status and extra fields", () => {
  for (const message of [undefined, null, 1, {}, "secret-canary",
    "test_docker_command_failed:network:256:unknown", "test_docker_command_failed:network:999:unknown",
    "test_docker_command_failed:network:01:unknown", "test_docker_command_failed:network:-1:unknown",
    "test_docker_command_failed:secret:1:unknown", "test_docker_command_failed:network:1:secret",
    "test_docker_command_failed:network:1:network_busy:secret-canary",
    "test_docker_command_failed:network:1:network_busy\n",
    "secret-canary:test_docker_command_failed:network:1:unknown"]) {
    assert.equal(machineDockerFailure({ message }), null);
  }
  assert.equal(machineDockerFailure(null), null);
});

test("unknown operations and malformed failures cannot leak arbitrary values", () => {
  for (const error of [null, "secret-canary", { status: "secret-canary", stderr: {} },
    { status: -1 }, { status: 256 }, { stderr: "x".repeat(16384) + "No such image" }]) {
    assert.throws(() => machineDockerCommand(["secret-canary"], () => { throw error; }),
      { message: "test_docker_command_failed:unknown:unknown:unknown" });
  }
  assert.throws(() => machineDockerCommand(["start"], () => { throw { code: "ETIMEDOUT" }; }),
    { message: "test_docker_command_failed:start:unknown:deadline" });
});
