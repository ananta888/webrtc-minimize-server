import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { superviseLiveInfrastructure, validLiveReport } from "../scripts/live-infrastructure-supervisor.mjs";

const environment = { LIVE_OIDC_USERNAME: "test-user", LIVE_OIDC_PASSWORD: "private-test-password" };
const passed = { status: "passed", relays: [{ tier: "infrastructure", candidateCount: 2, relayCount: 1 }] };
const absent = () => { throw Object.assign(new Error(), { code: "ESRCH" }); };

function scenario(action, overrides = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 123456 });
  const calls = [];
  return { calls, promise: superviseLiveInfrastructure({ environment, timeoutMs: 1000, kill: absent, platform: "linux",
    forkImpl: (entry, args, options) => {
      calls.push({ entry, args, options });
      queueMicrotask(() => action(child));
      return child;
    }, ...overrides }) };
}

test("fixed child receives only allowlisted configuration and no raw IO", async () => {
  const { calls, promise } = scenario(child => { child.emit("message", passed); child.emit("exit", 0); }, {
    environment: { ...environment, NODE_OPTIONS: "private-injected-code", OTHER_SECRET: "private-value", PATH: process.env.PATH },
  });
  const result = await promise;
  assert.equal(result.status, "passed");
  assert.deepEqual(result.relays, passed.relays);
  assert.equal(result.productionReleaseEvidence, false);
  assert.equal(result.selectedPairAndPayloadVerified, false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].entry.endsWith("/scripts/live-infrastructure-worker.mjs"));
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  assert.deepEqual(calls[0].options.execArgv, ["--max-old-space-size=256"]);
  assert.equal(calls[0].options.env.RUN_LIVE_INFRASTRUCTURE, "1");
  assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(calls[0].options.env.OTHER_SECRET, undefined);
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("missing credentials and invalid configuration fail before process creation", async () => {
  for (const overrides of [
    { environment: {} }, { environment: { ...environment, LIVE_OIDC_PASSWORD: "" } },
    { environment: { ...environment, LIVE_OIDC_USERNAME: "x".repeat(8193) } },
    { timeoutMs: 0 }, { timeoutMs: 120001 },
    { platform: "win32" },
    ...["http://remote.example", "https://meet.example/", "https://u:p@meet.example", "https://meet.example?token=private", "https://meet.example/#private"].map(LIVE_APP_ORIGIN => ({ environment: { ...environment, LIVE_APP_ORIGIN } })),
    { environment: { ...environment, LIVE_OIDC_ISSUER: "https://identity.example/realm/" } },
    { environment: { ...environment, LIVE_REQUIRE_INFRASTRUCTURE_TURN: "false" } },
  ]) {
    const report = await superviseLiveInfrastructure({ environment, platform: "linux", ...overrides,
      forkImpl: () => assert.fail("must not start a child") });
    assert.equal(report.status, "failed");
    assert.deepEqual(report.relays, []);
    assert.equal(JSON.stringify(report).includes("private"), false);
  }
});

test("IPC contract rejects extra data, duplicate tiers and invalid counts", () => {
  assert.equal(validLiveReport(passed), true);
  assert.equal(validLiveReport({ status: "failed", relays: [] }), true);
  for (const value of [null, [], {}, { ...passed, token: "private" },
    { status: "passed", relays: [] }, { status: "failed", relays: passed.relays },
    { status: "passed", relays: [...passed.relays, ...passed.relays] },
    ...[null, {}, { ...passed.relays[0], url: "private" }, { ...passed.relays[0], tier: "unknown" },
      { ...passed.relays[0], candidateCount: 4097 }, { ...passed.relays[0], relayCount: 3 },
      { ...passed.relays[0], relayCount: 0 }, { ...passed.relays[0], relayCount: 0.5 }]
      .map(row => ({ status: "passed", relays: [row] })),
  ]) assert.equal(validLiveReport(value), false);
});

for (const [label, action, code] of [
  ["no report", child => child.emit("exit", 0), "live_child_failed"],
  ["failed exit", child => { child.emit("message", passed); child.emit("exit", 1); }, "live_child_failed"],
  ["failed report", child => { child.emit("message", { status: "failed", relays: [] }); child.emit("exit", 0); }, "live_child_failed"],
  ["invalid report", child => child.emit("message", { secret: "private" }), "live_report_invalid"],
  ["duplicate report", child => { child.emit("message", passed); child.emit("message", passed); child.emit("exit", 0); }, "live_report_invalid"],
  ["child error", child => child.emit("error", new Error("private")), "live_child_failed"],
]) test(`supervisor rejects ${label} with closed diagnostics`, async () => {
  const { promise } = scenario(action);
  assert.deepEqual(await promise, { schema: "ananta.meet-live-infrastructure-result.v1", status: "failed", code,
    relays: [], productionReleaseEvidence: false, selectedPairAndPayloadVerified: false });
});

test("deadline terminates only owned group and restores signal listeners", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const signals = [];
  const { promise } = scenario(() => {}, { timeoutMs: 10, kill: (pid, signal) => signals.push([pid, signal]) });
  assert.equal((await promise).code, "live_deadline_exceeded");
  assert.deepEqual(signals, [[-123456, "SIGTERM"], [-123456, "SIGKILL"]]);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("cancellation, fork and cleanup errors are bounded and content free", async () => {
  assert.equal((await scenario(() => process.emit("SIGINT")).promise).code, "live_cancelled");
  assert.equal((await superviseLiveInfrastructure({ environment, platform: "linux", forkImpl: () => { throw new Error("private"); } })).code, "live_child_failed");
  const { promise } = scenario(child => { child.emit("message", passed); child.emit("exit", 0); }, {
    kill: () => { throw new Error("private"); },
  });
  const report = await promise;
  assert.equal(report.code, "live_cleanup_failed");
  assert.deepEqual(report.relays, []);
});

test("real noninteractive hung child is reaped at deadline", {
  timeout: 5000, skip: !["linux", "darwin"].includes(process.platform) && "requires POSIX process groups",
}, async context => {
  let child;
  context.after(() => { if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL"); });
  const report = await superviseLiveInfrastructure({ environment, timeoutMs: 100,
    forkImpl: (_entry, _args, options) => {
      child = spawn(process.execPath, ["--input-type=module", "-e", 'process.stderr.write("private-test-secret"); setInterval(() => {}, 1000);'], options);
      return child;
    },
  });
  assert.equal(report.code, "live_deadline_exceeded");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.equal(JSON.stringify(report).includes("private"), false);
});

test("owned process group includes an uncooperative descendant", {
  timeout: 5000, skip: process.platform !== "linux" && "requires Linux /proc observation",
}, async context => {
  let child, descendant;
  context.after(() => {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  });
  const promise = superviseLiveInfrastructure({ environment, timeoutMs: 700,
    forkImpl: (_entry, _args, options) => {
      const script = `import { spawn } from "node:child_process";
        process.on("SIGTERM", () => {});
        spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: "ignore" });
        setInterval(() => {}, 1000);`;
      child = spawn(process.execPath, ["--input-type=module", "-e", script], options);
      return child;
    },
  });
  for (let attempt = 0; attempt < 40 && !descendant; attempt++) {
    const children = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8");
    descendant = Number(children.trim().split(/\s+/)[0]) || undefined;
    if (!descendant) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(Number.isInteger(descendant) && descendant > 1);
  assert.equal((await promise).code, "live_deadline_exceeded");
  let stopped = false;
  for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
    try {
      const status = await readFile(`/proc/${descendant}/status`, "utf8");
      // A terminated orphan can remain a zombie until this container's init reaps it.
      stopped = /^State:\s+Z\b/m.test(status);
    } catch (error) { if (error.code !== "ENOENT") throw error; stopped = true; }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(stopped, true, "owned descendant must no longer execute");
});
