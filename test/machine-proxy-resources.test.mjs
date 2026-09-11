import assert from "node:assert/strict";
import test from "node:test";
import { projectMachineProxyResources } from "./helpers/machine-proxy-resources.mjs";

function record() {
  const rest = Array(49).fill("0");
  rest[10] = "19"; rest[11] = "23"; rest[16] = "7";
  rest[6] = "71"; rest[8] = "3"; rest[38] = "9";
  // These are deliberately forbidden raw address/identity canaries.
  rest[0] = "918273"; rest[24] = "private-address-canary";
  return `1 (node) S ${rest.join(" ")}\nusage_usec 45000\nuser_usec 24000\nsystem_usec 21000\nnr_periods 50\nnr_throttled 40\nthrottled_usec 4000000\nlow 0\nhigh 0\nmax 2\noom 0\noom_kill 0\noom_group_kill 0\n`;
}

test("proxy kernel observation projects only fixed numeric CPU/memory and PID1 state fields", () => {
  const value = projectMachineProxyResources(record());
  assert.deepEqual(value, { process: { state: "S", userTicks: 19, systemTicks: 23, threads: 7,
    minorFaults: 71, majorFaults: 3, blockIoTicks: 9 },
    cpu: { usage_usec: 45000, user_usec: 24000, system_usec: 21000, nr_periods: 50, nr_throttled: 40, throttled_usec: 4000000 },
    memory: { low: 0, high: 0, max: 2, oom: 0, oom_kill: 0, oom_group_kill: 0 }, io: null });
  for (const item of [value, value.process, value.cpu, value.memory]) assert.ok(Object.isFrozen(item));
  assert.doesNotMatch(JSON.stringify(value), /node|918273|private|address|canary/);
  assert.ok(JSON.stringify(value).length < 512);
});

test("faults and storage counters are bounded and duplicate fields cannot manufacture I/O evidence", () => {
  const value = projectMachineProxyResources(record() + "rchar: 123\nsyscr: 42\nread_bytes: 8192\nwrite_bytes: 0\n");
  assert.deepEqual(value.io, { readBytes: 8192, readCalls: 42 }); assert.ok(Object.isFrozen(value.io));
  assert.doesNotMatch(JSON.stringify(value), /rchar|write_bytes/);
  for (const bad of ["-1", "01", "1.2", "NaN", "9007199254740992", "2 extra", "private-canary"]) {
    const projection = projectMachineProxyResources(record() + `read_bytes: ${bad}\nsyscr: ${bad}\n`);
    assert.deepEqual(projection.io, { readBytes: null, readCalls: null });
    assert.doesNotMatch(JSON.stringify(projection), /private-canary/);
  }
  assert.deepEqual(projectMachineProxyResources(record() + "read_bytes: 1\nread_bytes: 2\nsyscr: 3\n").io,
    { readBytes: null, readCalls: 3 });
  assert.equal(projectMachineProxyResources(record().replace(" 71 ", " -1 ")).process.minorFaults, null);
  assert.equal(projectMachineProxyResources(record().replace(" 3 ", " NaN ")).process.majorFaults, null);
  assert.equal(projectMachineProxyResources(record().replace(" 9 ", " 9007199254740992 ")).process.blockIoTicks, null);
});

test("unsupported, oversized and malformed kernel records never become a healthy process", () => {
  for (const raw of [null, {}, Buffer.from(record()), "x".repeat(4097), "ü".repeat(2049)]) {
    assert.equal(projectMachineProxyResources(raw), null);
  }
  for (const raw of ["", "private-command-canary", record().replace("1 (node)", "2 (node)"),
    record().replace("(node)", "(private-command-canary)"), record().replace(" S ", " UNKNOWN "),
    record().replace("19 23", "NaN 23"), record().replace("19 23", "-1 23"),
    record().replace("19 23", "9007199254740992 23"), record().replace(" 7 ", " 33 ")]) {
    const value = projectMachineProxyResources(raw);
    assert.equal(value.process, null); assert.doesNotMatch(JSON.stringify(value), /private-command|NaN|UNKNOWN/);
  }
});

test("duplicate or invalid metric values stay unknown, missing metrics are not invented zeros", () => {
  for (const bad of ["-1", "01", "1.5", "NaN", "9007199254740992", "1 extra", "private-canary"]) {
    const value = projectMachineProxyResources("1 (node) R\nusage_usec " + bad + "\n");
    assert.equal(value.cpu.usage_usec, null); assert.equal(value.cpu.user_usec, null);
    assert.equal(value.memory, null); assert.equal(value.process, null);
    assert.doesNotMatch(JSON.stringify(value), /private-canary/);
  }
  const duplicate = projectMachineProxyResources(record() + "usage_usec 1\nusage_usec 2\n");
  assert.equal(duplicate.cpu.usage_usec, null);
  assert.equal(duplicate.cpu.user_usec, 24000);
});
