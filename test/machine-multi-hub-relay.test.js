import assert from "node:assert/strict";
import test from "node:test";
import { multiHubIcePath, multiRelayMatches } from "./helpers/machine-multi-hub-relay.mjs";

function observation(expected = 2) {
  return { connections: expected, sctpConnections: expected, pairs: expected, relayPairs: expected,
    policyFailures: 0, sent: 1000, received: 2000, udp: expected, tcp: 0, unknownProtocol: 0 };
}

test("multi-Worker bridge preserves Direct and rejects unknown transport settings", () => {
  assert.equal(multiHubIcePath(), "direct");
  for (const mode of ["direct", "turn-udp", "turn-tcp"]) assert.equal(multiHubIcePath(mode), mode);
  for (const mode of [null, "", "TURN-UDP", "turn-tls", {}, 1]) assert.throws(() => multiHubIcePath(mode));
});

test("multi-Worker relay observation requires selected data-bearing independent pairs", () => {
  assert.equal(multiRelayMatches(observation(), 2, "udp"), true);
  assert.equal(multiRelayMatches(observation(1), 1, "udp"), true);
  assert.equal(multiRelayMatches({ ...observation(), tcp: 2, udp: 0 }, 2, "tcp"), true);
  for (const change of [{ connections: 1 }, { sctpConnections: 0 }, { pairs: 3 }, { relayPairs: 1 },
    { policyFailures: 1 }, { sent: 0 }, { received: 0 }, { sent: NaN }, { received: "2000" },
    { udp: 1 }, { tcp: 2, udp: 0 }, { extra: "private" }]) {
    assert.equal(multiRelayMatches({ ...observation(), ...change }, 2, "udp"), false);
  }
  assert.equal(multiRelayMatches(null, 2, "udp"), false);
  assert.throws(() => multiRelayMatches(observation(), 3, "udp"));
  assert.throws(() => multiRelayMatches(observation(), 2, "tls"));
});

test("two observations must advance both byte counters", () => {
  const before = observation();
  assert.equal(multiRelayMatches(before, 2, "udp", before), false);
  assert.equal(multiRelayMatches({ ...before, sent: 1001 }, 2, "udp", before), false);
  assert.equal(multiRelayMatches({ ...before, received: 2001 }, 2, "udp", before), false);
  assert.equal(multiRelayMatches({ ...before, sent: 1001, received: 2001 }, 2, "udp", before), true);
});
