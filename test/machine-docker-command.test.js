import test from "node:test";
import assert from "node:assert/strict";
import { machineDockerCommand } from "./helpers/machine-docker-command.js";

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
    ["Address already in use", "network_address"], ["NanoCPUs unsupported", "cpu_limit"],
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

test("unknown operations and malformed failures cannot leak arbitrary values", () => {
  for (const error of [null, "secret-canary", { status: "secret-canary", stderr: {} },
    { status: -1 }, { status: 256 }, { stderr: "x".repeat(16384) + "No such image" }]) {
    assert.throws(() => machineDockerCommand(["secret-canary"], () => { throw error; }),
      { message: "test_docker_command_failed:unknown:unknown:unknown" });
  }
  assert.throws(() => machineDockerCommand(["start"], () => { throw { code: "ETIMEDOUT" }; }),
    { message: "test_docker_command_failed:start:unknown:deadline" });
});
