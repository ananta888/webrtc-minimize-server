import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { machineRelayObservation, assertMachineRelayObservation } from "./helpers/machine-relay-observation.js";

async function observe(patch = {}) {
  const pair = { id: "pair", type: "candidate-pair", state: "in-progress", nominated: true,
    localCandidateId: "local", bytesSent: 100, bytesReceived: 200, ...patch.pair };
  const transport = { id: "transport", type: "transport", dtlsState: "connected", selectedCandidatePairId: "pair", ...patch.transport };
  const local = { id: "local", type: "local-candidate", candidateType: "relay", relayProtocol: "tcp", ...patch.local };
  const pc = { connectionState: "connected", iceConnectionState: "connected",
    sctp: { state: "connected", transport: { state: "connected" } },
    getStats: async () => new Map([pair, transport, local].map(v => [v.id, v])),
    getConfiguration: () => ({ iceTransportPolicy: "relay" }), ...patch.pc };
  return machineRelayObservation({ evaluate: fn => vm.runInNewContext(`(${fn.toString()})()`, { window: { __pcs: [pc] } }) });
}

test("connected current TURN pair remains observable during checks with actual bidirectional traffic", async () => {
  const result = await observe();
  assertMachineRelayObservation(result, "tcp"); assert.equal(result.sctpConnections, 1);
  assertMachineRelayObservation(await observe({ pair: { state: "succeeded" } }), "tcp");
});

test("in-progress alone, nomination, stale selection or incomplete transports never prove relay readiness", async () => {
  for (const patch of [
    ...["failed", "waiting", "frozen", "unknown", undefined].map(state => ({ pair: { state } })),
    { pair: { bytesSent: 0 } }, { pair: { bytesReceived: 0 } },
    { transport: { selectedCandidatePairId: undefined } }, { transport: { selectedCandidatePairId: "other" } },
    { transport: { dtlsState: "connecting" } }, { pc: { connectionState: "connecting" } },
    { pc: { iceConnectionState: "checking" } },
    { pc: { sctp: { state: "connecting", transport: { state: "connected" } } } },
    { pc: { sctp: { state: "connected", transport: { state: "connecting" } } } },
  ]) assert.equal((await observe(patch)).pairs, 0, JSON.stringify(patch));
  assert.throws(() => assertMachineRelayObservation({ connections: 1, pairs: 1, relayPairs: 0 }, "tcp"));
  assert.equal((await observe({ local: { candidateType: "host" } })).relayPairs, 0);
});
