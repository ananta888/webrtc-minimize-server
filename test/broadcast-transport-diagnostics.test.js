import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { installBroadcastTransportDiagnostics } from "../scripts/broadcast-transport-diagnostics.mjs";

test("test-only transport diagnostics retain bounded states but no SDP, ICE addresses or credentials", async () => {
  let tick;
  let now = 100;
  const forbidden = "SECRET-CANARY";
  const peer = {
    connectionState: "connecting", iceConnectionState: "checking", iceGatheringState: "gathering",
    signalingState: "stable", localDescription: { sdp: forbidden }, remoteDescription: { sdp: forbidden },
    getStats: async () => new Map([
      [1, { type: "local-candidate", candidateType: "relay", protocol: "tcp", address: forbidden, url: forbidden }],
      [2, { type: "remote-candidate", candidateType: forbidden, protocol: forbidden, username: forbidden }],
      [3, { type: "candidate-pair", state: "in-progress", remoteCandidateId: forbidden }],
      [4, { type: "outbound-rtp", kind: "video", bytesSent: 600, framesEncoded: 4, qualityLimitationReason: forbidden }],
      [5, { type: "transport", dtlsState: "new", bytesSent: 20, certificate: forbidden }],
    ]),
  };
  const window = { __broadcastGateConnections: [peer] };
  runInNewContext(`(${installBroadcastTransportDiagnostics.toString()})()`, {
    window, performance: { now: () => now }, setInterval: fn => { tick = fn; },
  });
  for (let i = 0; i < 12; i++) { await tick(); now += 2000; }
  assert.equal(window.__broadcastGateTransportStats.length, 8);
  const snapshot = window.__broadcastGateTransportStats.at(-1)[0];
  assert.equal(snapshot.ageMs, 22000);
  assert.equal(snapshot.remoteDescription, true);
  assert.equal(snapshot.candidates["local-candidate:relay:tcp"], 1);
  assert.equal(snapshot.candidates["remote-candidate:unknown:unknown"], 1);
  assert.equal(snapshot.pairs["in-progress"], 1);
  assert.equal(snapshot.rtp[0].bytes, 600);
  assert.ok(!JSON.stringify(window.__broadcastGateTransportStats).includes(forbidden));
  peer.connectionState = "closed";
  await tick();
  assert.equal(window.__broadcastGateTransportStats.at(-1)[0].ageMs, 22000);
});
