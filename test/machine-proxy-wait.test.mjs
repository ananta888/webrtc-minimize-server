import assert from "node:assert/strict";
import test from "node:test";
import { projectMachineProxyWait } from "./helpers/machine-proxy-wait.mjs";
import { observeMachineProxyFailure } from "./helpers/machine-proxy-failure-observation.mjs";

test("kernel wait projection never exposes arbitrary symbols, offsets, addresses or hidden records", () => {
  for (const symbol of ["folio_wait_bit_common", "wait_on_page_bit_common", "io_schedule", "do_epoll_wait", "ep_poll"]) {
    assert.equal(projectMachineProxyWait(symbol), symbol); assert.equal(projectMachineProxyWait(symbol + "\n"), symbol);
  }
  for (const raw of [null, {}, Buffer.from("ep_poll"), "0", "private-canary", "ffffffffdeadbeef", "ep_poll+0x42",
    "ep_poll\nprivate-canary", "ep_poll\n\n", " ep_poll", "ep_poll ", "ep_poll\r\n", "x".repeat(129)]) {
    assert.equal(projectMachineProxyWait(raw), null);
  }
});

test("a failed or unavailable wait read cannot discard valid other evidence", () => {
  const name = "meet-test-tls-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  for (const denied of [true, false]) {
    const result = observeMachineProxyFailure(name, (_file, args) => {
      if (args.at(-1) === "/proc/1/wchan") {
        if (denied) throw new Error("private-permission-error");
        return "folio_wait_bit_common";
      }
      if (args[0] === "logs") return "test_tls_process_entered\n";
      return "";
    });
    assert.equal(result.waitSymbol, denied ? null : "folio_wait_bit_common");
    assert.equal(result.processEntered, true); assert.equal(result.listenerAnnounced, false);
    assert.doesNotMatch(JSON.stringify(result), /private-permission/);
  }
});
